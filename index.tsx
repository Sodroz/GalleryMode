/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Text } from "@components/Text";
import { copyToClipboard } from "@utils/clipboard";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { saveFile } from "@utils/web";
import type { Channel } from "@vencord/discord-types";
import { findByPropsLazy, findComponentByCodeLazy } from "@webpack";
import {
    ChannelStore,
    Menu,
    Modal,
    openModal,
    React,
    RestAPI,
    showToast,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "@webpack/common";

import style from "./style.css?managed";

const log = new Logger("GalleryMode");

enum FavouriteItemFormat { NONE = 0, IMAGE = 1, VIDEO = 2 }
interface FavoriteButtonProps {
    format: FavouriteItemFormat;
    src: string;
    url: string;
    width: number;
    height: number;
    className?: string;
}

type MediaItem = {
    key: string;
    url: string;
    proxyUrl?: string;
    sourceUrl: string;
    isGif: boolean;
    isVideo: boolean;
    messageId: string;
    channelId: string;
    threadName?: string;
    knownWidth?: number;
    knownHeight?: number;
};

/** Search scoped to a forum's threads rather than the forum channel itself. */
type ForumScope = {
    channelIds: string[]; // active thread ids + the forum's own id (forum header messages)
    threadNames: Record<string, string>;
    threadCount: number;
};

type FilterType = "all" | "images" | "gifs" | "videos";

type SearchTag = "image" | "video" | "embed";

type SubSearchState = {
    tag: SearchTag;
    offset: number;
    hasMore: boolean;
};

type SortOrder = "asc" | "desc";

/** Everything that defines *which* media the search returns, as opposed to how it's displayed. */
type QueryOptions = {
    afterDate: string;
    beforeDate: string;
    sortOrder: SortOrder;
};

const JumpAction = findByPropsLazy("jumpToMessage");
const FavoriteButton = findComponentByCodeLazy<FavoriteButtonProps>("#{intl::GIF_TOOLTIP_ADD_TO_FAVORITES}");
const VIDEO_EXT_RE = /\.(mp4|webm|mov)($|\?)/i;
// Attachment content_type is optional in Discord's payload, and bots / re-upload proxies routinely
// send application/octet-stream for real images. The extension is the fallback signal.
// Both patterns anchor on ($|\?) because signed CDN URLs append query params after the extension.
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|avif|tiff?|svg)($|\?)/i;
const IMAGE_GIF_RE = /\.(gif)($|\?)/i;

const Quality = {
    High: 1,
    Reasonable: 2,
    Low: 3,
    Horrible: 4,
} as const;

const qualities = [
    { giphy: "giphy", tenor: "Ax", video: "Po" },
    { giphy: "480w", tenor: "A5", video: "P3" },
    { giphy: "200", tenor: "A1", video: "P2" },
    { giphy: "100", tenor: "A2", video: "P4" },
];

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const mediaTenorRegex = /^https:\/\/(?:media\d?|c)\.tenor\.com(?:\/m)?\/(?<id>.+?)(?<quality>\w{2})\/(?<name>[^/]+)\.(?<ext>gif|webp|mp4|webm)$/i;
const giphyLinkRegex = /^https:\/\/media\d?\.giphy\.com\/media\/.*?\/(?<code>.*?)\/giphy/i;

const settings = definePluginSettings({
    gridColumns: {
        type: OptionType.NUMBER,
        description: "Number of columns (0 = adaptive based on window size)",
        default: 4,
    },
    gifQuality: {
        type: OptionType.SELECT,
        description: "GIF quality level",
        options: [
            { label: "High", value: Quality.High, default: true },
            { label: "Reasonable", value: Quality.Reasonable },
            { label: "Low", value: Quality.Low },
            { label: "Horrible", value: Quality.Horrible },
        ],
    },
    cacheTtlMinutes: {
        type: OptionType.NUMBER,
        description: "Minutes to remember gallery position after closing (0 = disabled)",
        default: 5,
    },
    prefetchNextPage: {
        type: OptionType.BOOLEAN,
        description: "Quietly pre-load the next page so scrolling stalls less",
        default: true,
    },
    layoutMode: {
        type: OptionType.SELECT,
        description: "Gallery layout style",
        options: [
            { label: "Square Grid", value: "grid", default: true },
            { label: "Masonry", value: "masonry" },
        ],
    },
});

type GalleryCache = {
    mediaItems: MediaItem[];
    subSearches: SubSearchState[];
    mediaSizes: Record<string, { width: number; height: number; }>;
    activeFilter: FilterType;
    afterDate: string;
    beforeDate: string;
    sortOrder: SortOrder;
    scrollTop: number;
    timestamp: number;
};

type PageResult = {
    items: MediaItem[];
    nextSearches: SubSearchState[];
    hitIndexing: boolean;
    hitRateLimit: boolean;
};

type PrefetchBuffer = {
    startedAtSeq: number;
    filter: FilterType;
    fromSearches: SubSearchState[];
    items: MediaItem[];
    nextSearches: SubSearchState[];
};

const channelCacheMap = new Map<string, GalleryCache>();

/** Forum-scoped galleries key off the forum id, so they never collide with a per-thread entry. */
function cacheKey(id: string, forumScope?: ForumScope | null) {
    return forumScope ? `forum:${id}` : id;
}

// fixed some media not showing up in some cases
function getSubSearches(filter: FilterType): SubSearchState[] {
    const tags: SearchTag[] = filter === "all"
        ? ["image", "video", "embed"]
        : filter === "videos"
            ? ["video"]
            : ["image", "embed"];

    return tags.map(tag => ({ tag, offset: 0, hasMore: true }));
}

function cloneSearches(searches: SubSearchState[]): SubSearchState[] {
    return searches.map(s => ({ ...s }));
}

function searchesKey(searches: SubSearchState[]): string {
    return searches.map(s => `${s.tag}:${s.offset}:${s.hasMore ? 1 : 0}`).join("|");
}

function hasMoreSearches(searches: SubSearchState[]): boolean {
    return searches.some(s => s.hasMore);
}

function isSameCursor(a: SubSearchState[], b: SubSearchState[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i].tag !== b[i].tag || a[i].offset !== b[i].offset || a[i].hasMore !== b[i].hasMore) return false;
    }
    return true;
}

function normalizeUrl(url: string) {
    return url.startsWith("//") ? `https:${url}` : url;
}

function parseCdnDimensions(url: string): { width: number; height: number; } | null {
    try {
        const parsed = new URL(url);
        const w = parseInt(parsed.searchParams.get("width") ?? "", 10);
        const h = parseInt(parsed.searchParams.get("height") ?? "", 10);
        if (w > 0 && h > 0) return { width: w, height: h };
    } catch {}
    return null;
}

// Discord snowflakes encode ms-since-the-Discord-epoch in their high bits, so a date range
// filter is expressed as min_id/max_id rather than as timestamps.
const DISCORD_EPOCH_MS = 1420070400000n;

function dateToSnowflake(date: string, endOfDay: boolean): string | undefined {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
    if (!match) return undefined;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!year || !month || !day) return undefined;

    // Local midnight / end-of-day, matching what the date input shows the user.
    const ms = endOfDay
        ? new Date(year, month - 1, day, 23, 59, 59, 999).getTime()
        : new Date(year, month - 1, day, 0, 0, 0, 0).getTime();
    if (!Number.isFinite(ms)) return undefined;

    // Clamp at the epoch: local midnight on 2015-01-01 falls *before* it in any timezone ahead
    // of UTC, which would otherwise emit a negative min_id.
    const delta = BigInt(ms) - DISCORD_EPOCH_MS;
    return (delta > 0n ? delta << 22n : 0n).toString();
}

async function copyMediaToClipboard(url: string, isVideo: boolean): Promise<boolean> {
    if (isVideo) {
        await copyToClipboard(url);
        return false;
    }
    try {
        const res = await fetch(url);
        const blob = await res.blob();
        const item = new ClipboardItem({ [blob.type]: blob });
        await navigator.clipboard.write([item]);
        return true;
    } catch {
        await copyToClipboard(url);
        return false;
    }
}

function getAspectRatio(item: MediaItem, mediaSizes: Record<string, { width: number; height: number; }>): string {
    const w = item.knownWidth ?? mediaSizes[item.key]?.width;
    const h = item.knownHeight ?? mediaSizes[item.key]?.height;
    return w && h ? `${w} / ${h}` : "1 / 1";
}

function getGifFavoriteUrl(item: Pick<MediaItem, "url" | "sourceUrl">) {
    return normalizeUrl(item.sourceUrl || item.url);
}

/**
 * Accept any http(s)/blob/data URL and let the client apply its own CSP. Do not reimplement the
 * policy here: the grid and the viewer share a document, so anything the grid renders is fine.
 */
function isUsableMediaUrl(url?: string): url is string {
    if (!url) return false;
    if (url.startsWith("blob:") || url.startsWith("data:")) return true;
    try {
        const { protocol } = new URL(url);
        return protocol === "https:" || protocol === "http:";
    } catch {
        return false;
    }
}

/**
 * Source URL for a still image: prefer the proxy (full resolution, and the only option Discord
 * will serve for an external host). Video is resolved by getViewerSrc instead.
 */
function getStillSrc(item: MediaItem): string | undefined {
    const direct = normalizeUrl(item.url);
    const proxy = item.proxyUrl ? normalizeUrl(item.proxyUrl) : undefined;
    if (isUsableMediaUrl(proxy)) return proxy;
    if (isUsableMediaUrl(direct)) return direct;
    return undefined;
}

/** True when the item must be played by a <video> element rather than shown as an image. */
function isVideoMedia(item: MediaItem): boolean {
    return item.isVideo || (item.isGif && VIDEO_EXT_RE.test(item.url));
}

/** Hosts that serve a player page rather than a media file; nothing can play these inline. */
const UNPLAYABLE_EMBED_HOST_RE = /(^|\.)(youtube\.com|youtu\.be|twitter\.com|x\.com|twitch\.tv|vimeo\.com|soundcloud\.com|spotify\.com|reddit\.com|tiktok\.com|instagram\.com|facebook\.com)$/i;

/**
 * Decided from the URL alone — an embed URL carries no media extension, so isVideoMedia() is false
 * for these and must not be used as a guard.
 */
function isUnplayableEmbed(item: MediaItem): boolean {
    try {
        const { hostname, pathname } = new URL(normalizeUrl(item.url));

        // A real file on one of these hosts is still playable (e.g. a video.twimg.com mp4).
        if (VIDEO_EXT_RE.test(pathname) || IMAGE_EXT_RE.test(pathname)) return false;
        if (UNPLAYABLE_EMBED_HOST_RE.test(hostname.toLowerCase())) return true;

        return /\/(embed|player)(\/|$)/i.test(pathname);
    } catch {
        return false;
    }
}

/** Single resolver for viewer + prefetch, so warmed bytes are the bytes rendered. */
function getViewerSrc(item: MediaItem): string {
    return isVideoMedia(item)
        ? normalizeUrl(item.url)
        : (getStillSrc(item) ?? normalizeUrl(item.url));
}

/**
 * Warm a neighbour into the HTTP cache. Video only fetches metadata + initial buffer, not the whole
 * clip. Returns a disposer so fast navigation cannot pile up in-flight requests.
 */
function prefetchMedia(item: MediaItem): () => void {
    const url = getViewerSrc(item);
    if (!isUsableMediaUrl(url)) return () => {};

    if (isVideoMedia(item)) {
        const video = document.createElement("video");
        video.preload = "metadata";
        video.muted = true;
        video.src = url;
        return () => {
            video.removeAttribute("src");
            video.load();
        };
    }

    const image = new Image();
    image.decoding = "async";
    image.src = url;
    return () => { image.src = ""; };
}

function getQualityUrl(url: string, qualityLevel: number) {
    const q = qualities[qualityLevel - 1] ?? qualities[0];
    const cleanUrl = normalizeUrl(url);

    const tenorMatch = cleanUrl.match(mediaTenorRegex);
    if (tenorMatch) {
        const { id, name, ext } = tenorMatch.groups!;
        const isVideo = ext === "mp4" || ext === "webm";
        return `https://media.tenor.com/${id}${isVideo ? q.video : q.tenor}/${name}.${isVideo ? ext : "webp"}`;
    }

    const giphyMatch = cleanUrl.match(giphyLinkRegex);
    if (giphyMatch) {
        const { code } = giphyMatch.groups!;
        if (VIDEO_EXT_RE.test(cleanUrl)) return cleanUrl;
        return `https://i.giphy.com/media/${code}/${q.giphy}.webp`;
    }

    try {
        const parsed = new URL(cleanUrl);

        // format=webp is an IMAGE transform. Applying it to an mp4/webm/mov asks the media proxy
        // to transcode a video into a still format; the request does not yield playable video and
        // the grid's <video> element renders nothing. Videos must be served untouched.
        if (VIDEO_EXT_RE.test(parsed.pathname)) return cleanUrl;

        // Note: the host is deliberately NOT rewritten here. cdn.discordapp.com URLs are
        // signature-scoped, and swapping the host was an unverified guess that risked breaking
        // otherwise-working image URLs.
        if (parsed.hostname === "cdn.discordapp.com" || parsed.hostname === "media.discordapp.net") {
            parsed.searchParams.set("format", "webp");
            parsed.searchParams.set("animated", "true");
            return parsed.toString();
        }
    } catch {}

    return cleanUrl;
}

function extractMediaFromMessage(msg: any): MediaItem[] {
    const items: MediaItem[] = [];
    const seenKeys = new Set<string>();
    const isGiphyEmbed = (embed: any) => embed?.url?.includes("giphy") || embed?.provider?.name === "Giphy";

    const addMedia = (url: string, forceGif = false, sourceUrl?: string, proxyUrl?: string, w?: number, h?: number) => {
        if (!url) return;
        const normalizedUrl = normalizeUrl(url);
        const key = `${msg.id}:${normalizedUrl}`;
        if (seenKeys.has(key)) return;
        seenKeys.add(key);
        const normalizedSourceUrl = normalizeUrl(sourceUrl || url);
        const normalizedProxyUrl = proxyUrl ? normalizeUrl(proxyUrl) : undefined;
        const lowerUrl = url.toLowerCase();
        const isVideoExt = VIDEO_EXT_RE.test(lowerUrl);
        const isGifExt = forceGif || IMAGE_GIF_RE.test(lowerUrl) || url.includes("tenor.com");
        const cdnDims = (!w || !h) ? parseCdnDimensions(normalizedProxyUrl ?? normalizedUrl) : null;
        items.push({
            key,
            url: normalizedUrl,
            proxyUrl: normalizedProxyUrl,
            sourceUrl: normalizedSourceUrl,
            isGif: isGifExt,
            isVideo: isVideoExt && !isGifExt,
            messageId: msg.id,
            channelId: msg.channel_id,
            knownWidth: w || cdnDims?.width,
            knownHeight: h || cdnDims?.height,
        });
    };

    msg.attachments?.forEach((a: any) => {
        const url = a.url || a.proxy_url;
        if (!url) return;

        const contentType = (a.content_type || "").toLowerCase();
        const declaredMedia = contentType.startsWith("image/") || contentType.startsWith("video/");
        // content_type is absent, empty, or a generic binary type far more often than expected,
        // which silently dropped perfectly ordinary images. Fall back to the extension.
        const looksLikeMedia = IMAGE_EXT_RE.test(a.filename || "") || IMAGE_EXT_RE.test(url)
            || VIDEO_EXT_RE.test(a.filename || "") || VIDEO_EXT_RE.test(url);

        if (declaredMedia || looksLikeMedia) {
            addMedia(url, false, undefined, a.proxy_url, a.width, a.height);
        }
    });

    msg.embeds?.forEach((e: any) => {
        const isTenor = e.provider?.name === "Tenor" || !!e.url?.includes("tenor");
        const isAnimated = (media: any) =>
            e.type === "gifv" || isTenor || isGiphyEmbed(e) || IMAGE_GIF_RE.test(media?.url || "");

        // Discord defines ~20 embed types. The old code accepted only image/video/gifv, so anything
        // a bot or app posted — which is nearly always type "rich" — was silently discarded; that is
        // why NotSoBot edits and similar output never showed up. Detect by CONTENT instead: if the
        // embed carries media, take it whatever it calls itself.
        //
        // Order matters. Video first, so a gifv/Tenor embed that also ships a thumbnail is recorded
        // as the animated media rather than its still frame.
        const candidates: any[] = [];
        if (e.video?.url) candidates.push(e.video);
        if (e.image?.url) candidates.push(e.image);
        // `images` (plural) is a real field for multi-image embeds and was never read at all.
        if (Array.isArray(e.images)) candidates.push(...e.images.filter((i: any) => i?.url));
        // Thumbnail only as a last resort — otherwise a link preview's tiny thumb would shadow the
        // full-size image of an embed that has both.
        if (candidates.length === 0 && e.thumbnail?.url) candidates.push(e.thumbnail);

        for (const media of candidates) {
            // The favourite/source target is the embed's page URL ONLY for providers whose GIFs are
            // identified by that page (Tenor, Giphy) or for true video/gifv embeds — which is what
            // the original per-type branches did. For a plain image candidate the page URL may be
            // completely unrelated to the media (an article that happens to contain a .gif), and
            // favouriting it would store the wrong link, so fall back to the media URL there.
            const usePageUrl = media === e.video || e.type === "gifv" || isTenor || isGiphyEmbed(e);

            addMedia(
                media.url,
                isAnimated(media),
                usePageUrl ? (e.url || media.url) : undefined,
                // EmbedMedia (client store) uses proxyURL; EmbedJSON (raw REST) uses proxy_url.
                // We fetch over RestAPI, so read both or every embed's proxyUrl is undefined.
                media.proxyURL || media.proxy_url,
                media.width,
                media.height
            );
        }
    });

    return items;
}

/**
 * Viewer for every media type.
 *
 * Discord's own media modal is unusable here — it re-resolves URLs internally and silently fails on
 * third-party video. Rendering everything ourselves also keeps navigation over a single list, so
 * arrows walk exactly what the grid shows (including the active filter).
 */
/** Click/Enter/Space surface used by every card type to open the viewer. */
function OpenSurface({ label, onOpen, children }: {
    label: string;
    onOpen: (e?: React.MouseEvent) => void;
    children: React.ReactNode;
}) {
    return (
        <div
            className="vc-gallery-media-open"
            role="button"
            tabIndex={0}
            aria-label={label}
            onClick={onOpen}
            onKeyDown={e => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                onOpen();
            }}
        >
            {children}
            <div className="vc-gallery-open-hint" aria-hidden="true">⤢</div>
        </div>
    );
}

function GalleryViewerModal({ items, startIndex, onJump, modalProps }: {
    items: MediaItem[];
    startIndex: number;
    onJump: (messageId: string, channelId?: string) => void;
    modalProps: any;
}) {
    const [index, setIndex] = useState(startIndex);
    // Our own maximize instead of the native fullscreen button, which paints grey in-window.
    const [maximized, setMaximized] = useState(false);
    const videoRef = useRef<HTMLVideoElement>(null);
    const item = items[index];

    const go = React.useCallback((delta: number) => {
        setIndex(prev => {
            const next = prev + delta;
            if (next < 0) return items.length - 1;
            if (next >= items.length) return 0;
            return next;
        });
    }, [items.length]);

    // Bound on window: the modal's focus target varies, and a keydown on <video> is swallowed by
    // its native controls.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
            else if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
            else if (e.key === "f" || e.key === "F") { e.preventDefault(); setMaximized(m => !m); }
            else if (e.key === "Escape" && maximized) {
                // Leave maximize first so Esc does not skip straight to closing the modal.
                e.preventDefault();
                e.stopPropagation();
                setMaximized(false);
            }
        };
        // Capture phase so Escape is seen before the modal's own close handler.
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [go, maximized]);

    // Restart playback when navigating onto a clip. Driven imperatively so navigation does not
    // depend on the element remounting.
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;
        video.currentTime = 0;
        void video.play().catch(() => { /* autoplay can be refused; controls remain */ });
    }, [index]);

    // Warm +1/+2/-1 so arrowing is instant. Delayed so holding a key does not fetch per frame.
    useEffect(() => {
        if (items.length < 2) return;

        // Dedup: in a 2-item gallery +1, +2 and -1 all wrap onto the same neighbour, which would
        // otherwise fire three identical fetches.
        const neighbours = [...new Set([index + 1, index + 2, index - 1]
            .map(i => (i + items.length * 2) % items.length))]
            .filter(i => i !== index)
            .map(i => items[i]);

        let disposers: Array<() => void> = [];
        const timer = setTimeout(() => {
            disposers = neighbours.map(prefetchMedia);
        }, 120);

        return () => {
            clearTimeout(timer);
            disposers.forEach(dispose => dispose());
        };
    }, [index, items]);

    if (!item) return null;

    const isVideoContent = isVideoMedia(item);
    // Same resolver the prefetcher uses, so the warmed bytes are the bytes rendered.
    const src = getViewerSrc(item);

    const typeLabel = item.isGif ? "GIF" : item.isVideo ? "Video" : "Image";

    return (
        <Modal {...modalProps} size="dynamic" title={`${typeLabel} · ${index + 1} / ${items.length}`}>
            <div className={`vc-gallery-viewer ${maximized ? "vc-gallery-viewer-max" : ""}`}>
                {items.length > 1 && (
                    <button
                        className="vc-gallery-viewer-nav vc-gallery-viewer-prev"
                        onClick={() => go(-1)}
                        aria-label="Previous"
                    >‹</button>
                )}

                {isVideoContent ? (
                    <video
                        ref={videoRef}
                        src={src}
                        className="vc-gallery-viewer-media"
                        controls={!item.isGif}
                        autoPlay
                        muted={item.isGif}
                        loop={item.isGif}
                        playsInline
                        // Native fullscreen is broken in-window; the ⤢ action below maximizes
                        // within the modal instead.
                        controlsList="nofullscreen"
                        disablePictureInPicture
                        onDoubleClick={e => {
                            e.preventDefault();
                            setMaximized(m => !m);
                        }}
                    />
                ) : (
                    <img
                        // Deliberately NOT keyed on item.key: reusing the element lets the browser
                        // swap in an already-cached bitmap without a mount/paint cycle.
                        src={src}
                        alt=""
                        className="vc-gallery-viewer-media"
                        onError={e => {
                            // One retry with the untransformed URL. The flag is namespaced per item
                            // because the element is reused across navigation — a flag left over
                            // from an earlier failure would otherwise suppress this item's retry.
                            const img = e.currentTarget;
                            const raw = normalizeUrl(item.url);
                            if (img.dataset.vcRetriedKey !== item.key && img.src !== raw) {
                                img.dataset.vcRetriedKey = item.key;
                                img.src = raw;
                            }
                        }}
                    />
                )}

                {items.length > 1 && (
                    <button
                        className="vc-gallery-viewer-nav vc-gallery-viewer-next"
                        onClick={() => go(1)}
                        aria-label="Next"
                    >›</button>
                )}
            </div>

            <div className="vc-gallery-viewer-actions">
                <button className="vc-gallery-viewer-btn" onClick={() => setMaximized(m => !m)}>
                    {maximized ? "⤡ Restore" : "⤢ Maximize"}
                </button>
                <button className="vc-gallery-viewer-btn" onClick={() => onJump(item.messageId, item.channelId)}>↗ Jump to message</button>
                <button className="vc-gallery-viewer-btn" onClick={() => copyMediaToClipboard(normalizeUrl(item.url), isVideoContent)}>⎘ Copy link</button>
                <button className="vc-gallery-viewer-btn" onClick={() => window.open(normalizeUrl(item.sourceUrl || item.url), "_blank", "noopener,noreferrer")}>↗ Open original</button>
            </div>
        </Modal>
    );
}

function GalleryModal({ channel, forumScope, modalProps }: { channel: any; forumScope?: ForumScope | null; modalProps: any }) {
    const gifQuality = settings.store.gifQuality ?? Quality.High;
    const cacheTtlMinutes = settings.store.cacheTtlMinutes ?? 30;
    const cacheTtlMs = cacheTtlMinutes > 0 ? cacheTtlMinutes * 60_000 : 0;
    const galleryCacheKey = cacheKey(channel.id, forumScope);

    const saved = cacheTtlMs > 0 ? channelCacheMap.get(galleryCacheKey) : null;
    if (saved && Date.now() - saved.timestamp >= cacheTtlMs) {
        channelCacheMap.delete(galleryCacheKey);
    }
    const cachedState = saved && Date.now() - saved.timestamp < cacheTtlMs ? saved : null;

    const [isFetching, setIsFetching] = useState(false);
    const [activeFilter, setActiveFilter] = useState<FilterType>(cachedState?.activeFilter ?? "all");
    const [mediaItems, setMediaItems] = useState<MediaItem[]>(cachedState?.mediaItems ?? []);
    const [subSearches, setSubSearches] = useState<SubSearchState[]>(cachedState?.subSearches ?? getSubSearches(cachedState?.activeFilter ?? "all"));
    const [mediaSizes, setMediaSizes] = useState<Record<string, { width: number; height: number; }>>(cachedState?.mediaSizes ?? {});
    const [layoutMode, setLayoutMode] = useState<"grid" | "masonry">((settings.store.layoutMode as "grid" | "masonry") ?? "grid");
    const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
    const [columnSetting, setColumnSetting] = useState(settings.store.gridColumns ?? 4);
    const [isIndexing, setIsIndexing] = useState(false);
    const [containerWidth, setContainerWidth] = useState(0);
    // Query options are intentionally per-session state rather than plugin settings: a saved
    // date range silently applying to a freshly opened channel reads as a broken gallery.
    const [afterDate, setAfterDate] = useState(cachedState?.afterDate ?? "");
    const [beforeDate, setBeforeDate] = useState(cachedState?.beforeDate ?? "");
    const [sortOrder, setSortOrder] = useState<SortOrder>(cachedState?.sortOrder ?? "desc");

    const gridRef = useRef<HTMLDivElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const mountedRef = useRef(true);
    const fetchingRef = useRef(false);
    const scrollTopRef = useRef(0);
    const indexingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const requestSeqRef = useRef(0);
    const loadObserverRef = useRef<IntersectionObserver | null>(null);
    const releaseObserverRef = useRef<IntersectionObserver | null>(null);
    const fetchFnRef = useRef<((isResetting?: boolean, targetFilter?: FilterType) => Promise<void>) | null>(null);
    const subSearchesRef = useRef(subSearches);
    const activeFilterRef = useRef(activeFilter);
    const queryOptionsRef = useRef<QueryOptions>({ afterDate, beforeDate, sortOrder });
    const mediaCountRef = useRef(mediaItems.length);
    const scrollAppliedRef = useRef(false);
    const prefetchBufferRef = useRef<PrefetchBuffer | null>(null);
    const prefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const prefetchBlockedUntilRef = useRef(0);
    const fetchModeRef = useRef<"idle" | "visible" | "prefetch">("idle");
    const inflightPromiseRef = useRef<Promise<PageResult | null> | null>(null);
    const inflightCursorKeyRef = useRef<string | null>(null);

    const stateRef = useRef<GalleryCache>({
        mediaItems: [],
        subSearches: getSubSearches("all"),
        mediaSizes: {},
        activeFilter: "all",
        afterDate: "",
        beforeDate: "",
        sortOrder: "desc",
        scrollTop: 0,
        timestamp: 0,
    });

    useLayoutEffect(() => {
        stateRef.current = {
            mediaItems,
            subSearches,
            mediaSizes,
            activeFilter,
            afterDate,
            beforeDate,
            sortOrder,
            scrollTop: scrollTopRef.current,
            timestamp: Date.now(),
        };
    }, [mediaItems, subSearches, mediaSizes, activeFilter, afterDate, beforeDate, sortOrder]);

    useEffect(() => {
        queryOptionsRef.current = { afterDate, beforeDate, sortOrder };
    }, [afterDate, beforeDate, sortOrder]);

    useEffect(() => {
        subSearchesRef.current = subSearches;
    }, [subSearches]);

    useEffect(() => {
        activeFilterRef.current = activeFilter;
    }, [activeFilter]);

    useEffect(() => {
        mediaCountRef.current = mediaItems.length;
    }, [mediaItems]);

    useEffect(() => {
        return () => {
            mountedRef.current = false;
            if (prefetchTimerRef.current) {
                clearTimeout(prefetchTimerRef.current);
                prefetchTimerRef.current = null;
            }
            prefetchBufferRef.current = null;
        };
    }, []);

    useEffect(() => {
        return () => {
            if (indexingTimeoutRef.current) clearTimeout(indexingTimeoutRef.current);
            if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
            if (queryChangeTimerRef.current) clearTimeout(queryChangeTimerRef.current);
        };
    }, []);

    useEffect(() => {
        if (cacheTtlMs <= 0) return;
        return () => {
            if (stateRef.current.mediaItems.length > 0) {
                channelCacheMap.delete(galleryCacheKey);
                channelCacheMap.set(galleryCacheKey, {
                    ...stateRef.current,
                    scrollTop: scrollTopRef.current,
                    timestamp: Date.now(),
                });
            }
            if (channelCacheMap.size > 50) {
                const oldestKey = channelCacheMap.keys().next().value;
                if (oldestKey) channelCacheMap.delete(oldestKey);
            }
        };
    }, [cacheTtlMs, galleryCacheKey]);

    useEffect(() => {
        if (loadObserverRef.current) return;

        // Near margin: hydrate media approaching the viewport.
        loadObserverRef.current = new IntersectionObserver(entries => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                const media = entry.target as HTMLImageElement | HTMLVideoElement;
                const { src } = media.dataset;
                if (src && media.dataset.vcGalleryLoaded !== "1") {
                    media.src = src;
                    if (media.tagName === "VIDEO") (media as HTMLVideoElement).load();
                    media.dataset.vcGalleryLoaded = "1";
                }
                if (media.tagName !== "VIDEO") loadObserverRef.current?.unobserve(media);
            }
        }, { root: scrollRef.current, rootMargin: "1200px 0px 1200px 0px" });

        // Far margin: release offscreen videos. The gap between the two margins is
        // hysteresis so boundary scrolling doesn't thrash load/release.
        releaseObserverRef.current = new IntersectionObserver(entries => {
            for (const entry of entries) {
                if (entry.isIntersecting) continue;
                const media = entry.target as HTMLVideoElement;
                if (media.tagName !== "VIDEO" || media.dataset.vcGalleryLoaded !== "1") continue;
                media.pause();
                media.removeAttribute("src");
                media.load(); // frees the decoder / buffered frames
                media.dataset.vcGalleryLoaded = "0";
            }
        }, { root: scrollRef.current, rootMargin: "3000px 0px 3000px 0px" });

        const pending = scrollRef.current?.querySelectorAll<HTMLElement>("[data-vc-gallery-lazy]");
        pending?.forEach(media => {
            loadObserverRef.current?.observe(media);
            if (media.tagName === "VIDEO") releaseObserverRef.current?.observe(media);
        });

        return () => {
            loadObserverRef.current?.disconnect();
            loadObserverRef.current = null;
            releaseObserverRef.current?.disconnect();
            releaseObserverRef.current = null;
        };
    }, []);

    useEffect(() => {
        if (!gridRef.current) return;
        const ro = new ResizeObserver(entries => {
            const { width } = entries[0].contentRect;
            requestAnimationFrame(() => {
                setContainerWidth(prev => prev === width ? prev : width);
            });
        });
        ro.observe(gridRef.current);
        return () => ro.disconnect();
    }, []);

    const effectiveColumns = useMemo(() => {
        if (columnSetting > 0) return columnSetting;
        if (!containerWidth) return 4;
        return Math.max(2, Math.floor((containerWidth + 12) / (200 + 12)));
    }, [columnSetting, containerWidth]);

    const hasMore = subSearches.some(search => search.hasMore);

    // Videos are watched by both observers (load near / release far); images only load.
    const registerMedia = (el: HTMLImageElement | HTMLVideoElement | null) => {
        if (!el) return;
        if (loadObserverRef.current) {
            loadObserverRef.current.observe(el);
            if (el.tagName === "VIDEO") releaseObserverRef.current?.observe(el);
        } else {
            // Observers not ready yet; the effect's querySelectorAll seed picks these up.
            el.dataset.vcGalleryLazy = "1";
        }
    };

    const setFetching = (value: boolean) => {
        fetchingRef.current = value;
        setIsFetching(value);
    };

    const setSearches = (next: SubSearchState[]) => {
        subSearchesRef.current = next;
        setSubSearches(next);
    };

    const rememberSize = (key: string, width: number, height: number) => {
        if (!width || !height) return;
        setMediaSizes(prev => {
            const current = prev[key];
            if (current?.width === width && current?.height === height) return prev;
            return { ...prev, [key]: { width, height } };
        });
    };

    const clearPrefetchTimer = () => {
        if (prefetchTimerRef.current) {
            clearTimeout(prefetchTimerRef.current);
            prefetchTimerRef.current = null;
        }
    };

    const invalidatePrefetch = () => {
        clearPrefetchTimer();
        prefetchBufferRef.current = null;
    };

    const isBufferValid = (buffer: PrefetchBuffer | null): buffer is PrefetchBuffer => {
        if (!buffer) return false;
        if (buffer.startedAtSeq !== requestSeqRef.current) return false;
        if (buffer.filter !== activeFilterRef.current) return false;
        return isSameCursor(buffer.fromSearches, subSearchesRef.current);
    };

    const applyPageResult = (result: Pick<PageResult, "items" | "nextSearches">, reset: boolean) => {
        // Compute next list synchronously so schedulePrefetch can trust mediaCountRef immediately.
        const prev = reset ? [] : stateRef.current.mediaItems;
        const seen = new Set(prev.map(item => item.key));
        const merged = reset
            ? result.items
            : (() => {
                const newItems = result.items.filter(item => !seen.has(item.key));
                return newItems.length ? [...prev, ...newItems] : prev;
            })();
        mediaCountRef.current = merged.length;
        stateRef.current = {
            ...stateRef.current,
            mediaItems: merged,
            subSearches: result.nextSearches,
            activeFilter: activeFilterRef.current,
            ...queryOptionsRef.current,
            scrollTop: scrollTopRef.current,
            timestamp: Date.now(),
        };
        setMediaItems(merged);
        setSearches(result.nextSearches);
    };

    const applyPrefetchBuffer = () => {
        const buffer = prefetchBufferRef.current;
        if (!isBufferValid(buffer)) return false;
        applyPageResult({ items: buffer.items, nextSearches: buffer.nextSearches }, false);
        prefetchBufferRef.current = null;
        return true;
    };

    const resetGalleryState = (filter = activeFilter) => {
        setMediaItems([]);
        setMediaSizes({});
        setSearches(getSubSearches(filter));
        mediaCountRef.current = 0;
        scrollTopRef.current = 0;
    };

    const jumpToMessage = (messageId: string, channelId?: string, e?: React.MouseEvent) => {
        e?.preventDefault();
        e?.stopPropagation();
        if (!JumpAction?.jumpToMessage) {
            log.error("jumpToMessage module not found");
            showToast({ text: "Unable to jump to message", variant: "critical" });
            return;
        }
        try {
            JumpAction.jumpToMessage({
                // In forum scope the item lives in a thread; jumping with the forum id would
                // land in the forum index, not the post.
                channelId: channelId ?? channel.id,
                messageId,
                flash: true,
                jumpType: "INSTANT",
            });
            modalProps.onClose();
        } catch (error) {
            log.error("jumpToMessage failed", error);
            showToast({ text: "Failed to jump to message", variant: "critical" });
        }
    };

    const runSearchPage = async (
        currentSearches: SubSearchState[],
        opts: { startedAtSeq: number; silent: boolean; isResetting: boolean; targetFilter: FilterType; }
    ): Promise<PageResult | null> => {
        const { startedAtSeq, silent, isResetting, targetFilter } = opts;
        const isStale = () => !mountedRef.current || startedAtSeq !== requestSeqRef.current;

        try {
            const isGuild = !!channel.guild_id;
            const searchUrl = isGuild
                ? `/guilds/${channel.guild_id}/messages/search`
                : `/channels/${channel.id}/messages/search`;

            if (!silent) setIsIndexing(false);

            const nextSearches = cloneSearches(currentSearches);
            const extractedMedia: MediaItem[] = [];

            for (const search of currentSearches.filter(s => s.hasMore)) {
                let retries = 0;
                let success = false;

                while (retries < (silent ? 1 : 3) && !success) {
                    if (isStale()) return null;

                    try {
                        const { afterDate: qAfter, beforeDate: qBefore, sortOrder: qSort } = queryOptionsRef.current;
                        const minId = qAfter ? dateToSnowflake(qAfter, false) : undefined;
                        const maxId = qBefore ? dateToSnowflake(qBefore, true) : undefined;

                        const response = await RestAPI.get({
                            url: searchUrl,
                            query: {
                                has: search.tag,
                                offset: search.offset,
                                // Without this Discord also returns the messages surrounding each
                                // hit, which we immediately discard — pure wasted transfer.
                                context_size: 0,
                                // Forum scope searches every thread at once: channel_id accepts an
                                // array (same mechanism GalleryView uses), server-side filtered.
                                ...(isGuild ? { channel_id: forumScope?.channelIds ?? channel.id } : {}),
                                ...((channel.nsfw || channel.isNSFW?.()) ? { include_nsfw: true } : {}),
                                ...(minId ? { min_id: minId } : {}),
                                ...(maxId ? { max_id: maxId } : {}),
                                sort_by: "timestamp",
                                sort_order: qSort,
                            },
                        });

                        if (isStale()) return null;

                        if (response.status === 202) {
                            if (silent) {
                                return { items: [], nextSearches: currentSearches, hitIndexing: true, hitRateLimit: false };
                            }
                            setIsIndexing(true);
                            indexingTimeoutRef.current = setTimeout(() => {
                                if (mountedRef.current) fetchFnRef.current?.(isResetting, targetFilter);
                            }, 3000);
                            return { items: [], nextSearches: currentSearches, hitIndexing: true, hitRateLimit: false };
                        }

                        const { body } = response;
                        const next = nextSearches.find(s => s.tag === search.tag);
                        const foundMessages = body?.messages?.map((hitGroup: any[]) => hitGroup?.[0]).filter(Boolean) ?? [];
                        const totalResults = body?.total_results ?? 0;
                        extractedMedia.push(...foundMessages.flatMap((msg: any) => {
                            const items = extractMediaFromMessage(msg);
                            // A thread created mid-session is not in the id list but its media is
                            // valid — Discord already filtered by the ids we sent; record the live
                            // name so the card/viewer can say which post it came from.
                            if (forumScope) {
                                const name = forumScope.threadNames[msg.channel_id]
                                    ?? ChannelStore.getChannel(msg.channel_id)?.name;
                                for (const item of items) item.threadName = name;
                            }
                            return items;
                        }));

                        if (next) {
                            const fetchedCount = foundMessages.length;
                            next.offset += fetchedCount;
                            next.hasMore = fetchedCount > 0 && next.offset < totalResults;
                        }

                        success = true;
                    } catch (error: any) {
                        if (error.status === 429) {
                            const retryAfterSec = Number(error.body?.retry_after ?? 5);
                            const waitSec = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec : 5;
                            if (silent) {
                                prefetchBlockedUntilRef.current = Date.now() + waitSec * 1000;
                                return { items: [], nextSearches: currentSearches, hitIndexing: false, hitRateLimit: true };
                            }
                            showToast({ text: `Rate limited. Waiting ${Math.ceil(waitSec)}s...`, variant: "default" });
                            await sleep(waitSec * 1000);
                            retries++;
                            if (retries >= 3) {
                                showToast({ text: `Skipped loading ${search.tag}s after 3 timeouts. Try again later.`, variant: "critical" });
                            }
                            continue;
                        }

                        log.error(`Search API failed for tag: ${search.tag}`, error);
                        break;
                    }
                }
            }

            if (isStale()) return null;

            return {
                items: extractedMedia,
                nextSearches,
                hitIndexing: false,
                hitRateLimit: false,
            };
        } catch (error) {
            if (!silent) log.error("Search API failed", error);
            else log.error("Prefetch search failed", error);
            return null;
        }
    };

    const startPageFetch = (
        searches: SubSearchState[],
        opts: { startedAtSeq: number; silent: boolean; isResetting: boolean; targetFilter: FilterType; }
    ) => {
        fetchModeRef.current = opts.silent ? "prefetch" : "visible";
        inflightCursorKeyRef.current = searchesKey(searches);
        const promise = runSearchPage(searches, opts).finally(() => {
            if (inflightPromiseRef.current === promise) {
                inflightPromiseRef.current = null;
                inflightCursorKeyRef.current = null;
                fetchModeRef.current = "idle";
            }
        });
        inflightPromiseRef.current = promise;
        return promise;
    };

    const schedulePrefetch = () => {
        if (!settings.store.prefetchNextPage) return;
        if (!mountedRef.current) return;
        if (mediaCountRef.current <= 0) return;
        if (!hasMoreSearches(subSearchesRef.current)) return;
        if (Date.now() < prefetchBlockedUntilRef.current) return;
        if (fetchModeRef.current !== "idle" || inflightPromiseRef.current) return;
        if (isBufferValid(prefetchBufferRef.current)) return;

        clearPrefetchTimer();
        prefetchTimerRef.current = setTimeout(() => {
            prefetchTimerRef.current = null;
            void runPrefetch();
        }, 400);
    };

    const runPrefetch = async () => {
        if (!settings.store.prefetchNextPage) return;
        if (!mountedRef.current) return;
        if (mediaCountRef.current <= 0) return;
        if (!hasMoreSearches(subSearchesRef.current)) return;
        if (Date.now() < prefetchBlockedUntilRef.current) return;
        if (fetchModeRef.current !== "idle" || inflightPromiseRef.current) return;
        if (isBufferValid(prefetchBufferRef.current)) return;

        const startedAtSeq = requestSeqRef.current;
        const filter = activeFilterRef.current;
        const fromSearches = cloneSearches(subSearchesRef.current);

        const result = await startPageFetch(fromSearches, {
            startedAtSeq,
            silent: true,
            isResetting: false,
            targetFilter: filter,
        });

        if (!result || !mountedRef.current) return;
        if (startedAtSeq !== requestSeqRef.current) return;
        if (filter !== activeFilterRef.current) return;
        if (!isSameCursor(fromSearches, subSearchesRef.current)) return;
        if (result.hitIndexing || result.hitRateLimit) return;

        prefetchBufferRef.current = {
            startedAtSeq,
            filter,
            fromSearches,
            items: result.items,
            nextSearches: result.nextSearches,
        };
    };

    const fetchOlderMessages = async (isResetting = false, targetFilter = activeFilter) => {
        const filter = targetFilter;
        const searches = isResetting ? getSubSearches(filter) : subSearchesRef.current;

        if (!isResetting && !hasMoreSearches(searches)) return;

        // 1) Warm buffer hit — apply instantly, no spinner.
        if (!isResetting && isBufferValid(prefetchBufferRef.current)) {
            applyPrefetchBuffer();
            schedulePrefetch();
            return;
        }

        // 2) Join in-flight prefetch for the same cursor.
        if (
            !isResetting
            && inflightPromiseRef.current
            && inflightCursorKeyRef.current === searchesKey(searches)
        ) {
            setFetching(true);
            fetchModeRef.current = "visible";
            try {
                const result = await inflightPromiseRef.current;
                if (!mountedRef.current) return;
                if (result && !result.hitIndexing && !result.hitRateLimit) {
                    // Only apply if the UI cursor still matches what this request fetched.
                    if (isSameCursor(searches, subSearchesRef.current)) {
                        applyPageResult(result, false);
                        schedulePrefetch();
                    }
                    return;
                }
            } finally {
                if (mountedRef.current) setFetching(false);
            }
            // Unusable quiet result — fall through to a normal visible fetch.
        } else if (!isResetting && fetchModeRef.current === "visible") {
            return;
        }

        // 3) Hard visible fetch.
        invalidatePrefetch();
        if (indexingTimeoutRef.current) {
            clearTimeout(indexingTimeoutRef.current);
            indexingTimeoutRef.current = null;
        }

        // Re-read cursor after possible await above; reset still uses fresh searches.
        const fetchSearches = isResetting ? searches : subSearchesRef.current;
        if (!isResetting && !hasMoreSearches(fetchSearches)) return;

        const startedAtSeq = ++requestSeqRef.current;
        setFetching(true);

        try {
            const result = await startPageFetch(fetchSearches, {
                startedAtSeq,
                silent: false,
                isResetting,
                targetFilter: filter,
            });

            if (!mountedRef.current || startedAtSeq !== requestSeqRef.current) return;
            if (!result || result.hitIndexing) return;

            applyPageResult(result, isResetting);
            schedulePrefetch();
        } finally {
            if (mountedRef.current) setFetching(false);
        }
    };

    useEffect(() => {
        fetchFnRef.current = fetchOlderMessages;
    });

    const initialFetchDone = useRef(mediaItems.length > 0);

    useEffect(() => {
        if (initialFetchDone.current) {
            // Restored from cache — warm the next page if enabled.
            schedulePrefetch();
            return;
        }
        initialFetchDone.current = true;
        fetchOlderMessages();
    }, []);

    useEffect(() => {
        if (cachedState?.scrollTop == null || !scrollRef.current) return;
        const el = scrollRef.current;
        let cancelled = false;
        requestAnimationFrame(() => {
            if (cancelled) return;
            requestAnimationFrame(() => {
                if (cancelled) return;
                el.scrollTop = cachedState.scrollTop!;
                scrollAppliedRef.current = true;
            });
        });
        return () => {
            cancelled = true;
        };
    }, []);

    const handleScroll = (e: any) => {
        const { scrollTop, scrollHeight, clientHeight } = e.target;
        scrollTopRef.current = scrollTop;
        if (scrollHeight - scrollTop <= clientHeight + 1200) fetchOlderMessages();
    };

    /**
     * Tear down and re-run the search after anything that changes *which* media matches.
     *
     * The cached entry must be evicted: channelCacheMap is keyed on channel id alone and has no
     * notion of which query produced its items, so keeping it would restore media from outside
     * the range the user just picked.
     */
    const resetForQueryChange = (filter = activeFilterRef.current) => {
        if (indexingTimeoutRef.current) {
            clearTimeout(indexingTimeoutRef.current);
            indexingTimeoutRef.current = null;
        }
        invalidatePrefetch();
        channelCacheMap.delete(galleryCacheKey);
        resetGalleryState(filter);
        fetchOlderMessages(true, filter);
    };

    const handleFilterChange = (type: FilterType) => {
        if (activeFilter === type) return;
        activeFilterRef.current = type;
        setActiveFilter(type);
        resetForQueryChange(type);
    };

    // Applied on commit rather than per keystroke: <input type="date"> fires change on a complete
    // date, but a debounce still protects against fast repeated edits re-firing all three streams.
    const queryChangeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const commitQueryChange = (next: Partial<QueryOptions>) => {
        queryOptionsRef.current = { ...queryOptionsRef.current, ...next };
        if (next.afterDate !== undefined) setAfterDate(next.afterDate);
        if (next.beforeDate !== undefined) setBeforeDate(next.beforeDate);
        if (next.sortOrder !== undefined) setSortOrder(next.sortOrder);

        if (queryChangeTimerRef.current) clearTimeout(queryChangeTimerRef.current);
        queryChangeTimerRef.current = setTimeout(() => {
            queryChangeTimerRef.current = null;
            if (mountedRef.current) resetForQueryChange();
        }, 300);
    };

    const getFavoriteButtonProps = (item: MediaItem) => {
        if (!item.isGif) return null;
        // Prefer a measured size, but fall back to known CDN/embed dimensions so the
        // favourite button still appears for videos that were released before measuring.
        const measured = mediaSizes[item.key];
        const width = measured?.width ?? item.knownWidth;
        const height = measured?.height ?? item.knownHeight;
        if (!width || !height) return null;
        const isVideoGif = VIDEO_EXT_RE.test(item.url);
        return {
            format: isVideoGif ? FavouriteItemFormat.VIDEO : FavouriteItemFormat.IMAGE,
            src: item.proxyUrl || item.url,
            url: getGifFavoriteUrl(item),
            width,
            height,
        } satisfies FavoriteButtonProps;
    };

    const displayedMedia = useMemo(() => mediaItems.filter(item => {
        if (activeFilter === "videos") return item.isVideo;
        if (activeFilter === "gifs") return item.isGif;
        if (activeFilter === "images") return !item.isVideo && !item.isGif;
        return true;
    }), [mediaItems, activeFilter]);

    // Distribute items across columns by greedily filling the shortest one, using
    // aspect-ratio to estimate each item's height. mediaSizes is left out of the deps
    // so a late image load doesn't re-run this and reshuffle the columns.
    const masonryColumns = useMemo(() => {
        const cols: MediaItem[][] = Array.from({ length: effectiveColumns }, () => []);
        if (layoutMode !== "masonry") return cols;
        const heights = new Array(effectiveColumns).fill(0);
        const estimateHeight = (item: MediaItem) => {
            const w = item.knownWidth ?? mediaSizes[item.key]?.width;
            const h = item.knownHeight ?? mediaSizes[item.key]?.height;
            return w && h ? h / w : 1; // height per unit column width; 1 = square fallback
        };
        for (const item of displayedMedia) {
            let shortest = 0;
            for (let i = 1; i < effectiveColumns; i++) {
                if (heights[i] < heights[shortest]) shortest = i;
            }
            cols[shortest].push(item);
            heights[shortest] += estimateHeight(item);
        }
        return cols;
    }, [displayedMedia, effectiveColumns, layoutMode]);

    const handleCopy = async (item: MediaItem, e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const url = item.proxyUrl || item.url;
        const copiedImage = await copyMediaToClipboard(url, item.isVideo);
        setCopyFeedback(copiedImage ? "Image copied!" : "URL copied!");
        if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
        copyTimeoutRef.current = setTimeout(() => setCopyFeedback(null), 2000);
    };

    /**
     * Open the clicked item in Discord's own media modal, passing the WHOLE gallery as the item
     * list so its native prev/next arrows and left/right keyboard navigation walk the gallery
     * instead of being stuck on one image.
     *
     * Items Discord can't display (external hosts blocked by CSP, non-media) are omitted from the
     * list rather than included as broken frames — so the arrow keys never land on a dead entry.
     * The clicked item's index is remapped onto the filtered list; if the click target itself
     * isn't displayable we fall back to opening it externally.
     */
    /** Open the viewer at the clicked item, navigating `displayedMedia` (so the filter applies). */
    const openInDiscord = (item: MediaItem, e?: React.MouseEvent) => {
        e?.preventDefault();
        e?.stopPropagation();

        try {
            (document.activeElement as HTMLElement | null)?.blur?.();
        } catch {
            // Non-fatal.
        }

        // Only items we can actually render, so the arrows never land on a dead frame. YouTube,
        // Twitter/X and similar hand back an iframe player page rather than a media file, so they
        // are skipped here and open in the browser instead.
        const viewable = displayedMedia.filter(entry =>
            !isUnplayableEmbed(entry) && isUsableMediaUrl(getViewerSrc(entry)));

        const startIndex = viewable.findIndex(entry => entry.key === item.key);

        if (startIndex < 0) {
            window.open(normalizeUrl(item.url), "_blank", "noopener,noreferrer");
            return;
        }

        openModal(props => (
            <ErrorBoundary>
                <GalleryViewerModal
                    items={viewable}
                    startIndex={startIndex}
                    onJump={(messageId, channelId) => {
                        props.onClose();
                        jumpToMessage(messageId, channelId);
                    }}
                    modalProps={props}
                />
            </ErrorBoundary>
        ));
    };

    const handleDownload = async (item: MediaItem, e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const url = item.proxyUrl || item.url;
        try {
            const res = await fetch(url);
            const blob = await res.blob();
            const ext = blob.type.split("/")[1] || url.split(".").pop()?.split("?")[0] || "bin";
            saveFile(new File([blob], `${item.messageId}.${ext}`, { type: blob.type }));
        } catch {
            window.open(url, "_blank");
        }
    };

    const renderCard = (item: MediaItem) => {
        const favoriteProps = getFavoriteButtonProps(item);
        const isVideoContent = isVideoMedia(item);
        const aspectRatio = getAspectRatio(item, mediaSizes);
        const cardStyle = layoutMode === "masonry" ? { aspectRatio } : {};

        // Shared by every lazy media element; the observer swaps data-src -> src when visible.
        const mediaProps = {
            "data-src": getQualityUrl(item.url, gifQuality),
            "data-vc-gallery-lazy": "1",
            className: "vc-gallery-media",
            ref: registerMedia,
        } as const;

        const media = isVideoContent
            ? (
                // GIFs arrive as mp4/webm, so they render in a <video> with no controls and the
                // whole surface opens the viewer. Real videos keep their controls, so only the
                // corner button opens it — clicking play must not also navigate.
                item.isGif ? (
                    <OpenSurface label="Open GIF" onOpen={e => openInDiscord(item, e)}>
                        <video
                            {...mediaProps}
                            autoPlay
                            muted
                            loop
                            playsInline
                            onLoadedMetadata={e => rememberSize(item.key, e.currentTarget.videoWidth, e.currentTarget.videoHeight)}
                        />
                    </OpenSurface>
                ) : (
                    <div className="vc-gallery-video-wrap">
                        <video
                            {...mediaProps}
                            controls
                            muted
                            loop
                            playsInline
                            // Chromium's native fullscreen paints grey in-window; the corner
                            // button and double-click open our viewer instead.
                            controlsList="nofullscreen"
                            disablePictureInPicture
                            onDoubleClick={e => { e.preventDefault(); openInDiscord(item, e); }}
                            onLoadedMetadata={e => rememberSize(item.key, e.currentTarget.videoWidth, e.currentTarget.videoHeight)}
                        />
                        <button
                            className="vc-gallery-expand-btn"
                            title="Open in viewer"
                            aria-label="Open in viewer"
                            onClick={e => openInDiscord(item, e)}
                        >⤢</button>
                    </div>
                )
            ) : (
                <OpenSurface label="Open image" onOpen={e => openInDiscord(item, e)}>
                    <img
                        {...mediaProps}
                        alt=""
                        onLoad={e => rememberSize(item.key, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
                        onError={e => {
                            // Retry once untransformed rather than hiding the card outright.
                            const img = e.currentTarget;
                            const raw = normalizeUrl(item.url);
                            if (img.dataset.vcRetried !== "1" && img.src !== raw) {
                                img.dataset.vcRetried = "1";
                                img.src = raw;
                                return;
                            }
                            const card = img.closest(".vc-gallery-card") as HTMLElement;
                            if (card) card.style.display = "none";
                        }}
                    />
                </OpenSurface>
            );

        return (
            <div key={item.key} className={`vc-gallery-card ${layoutMode === "masonry" ? "vc-gallery-card-masonry" : ""}`} style={cardStyle}>
                {favoriteProps ? <div className="vc-gallery-fav-btn-wrap"><FavoriteButton {...favoriteProps} className="vc-gallery-fav-btn" /></div> : null}
                {media}
                {forumScope && item.threadName && (
                    <div className="vc-gallery-thread-chip" title={`From post: ${item.threadName}`}>{item.threadName}</div>
                )}
                <div className="vc-gallery-card-actions">
                    <div className="vc-gallery-action-btn" title="Copy" onClick={e => handleCopy(item, e)}>⎘</div>
                    <div className="vc-gallery-action-btn" title="Download" onClick={e => handleDownload(item, e)}>↓</div>
                    <div className="vc-gallery-action-btn" title="Jump to message" onClick={e => jumpToMessage(item.messageId, item.channelId, e)}>↗</div>
                </div>
            </div>
        );
    };

    return (
        <Modal {...modalProps} size="dynamic" title={`Gallery: ${channel.name}`}>
            {forumScope && (
                <div style={{ color: "var(--text-muted)", fontSize: "12px", marginBottom: "8px" }}>
                    All threads · {forumScope.threadCount} {forumScope.threadCount === 1 ? "post" : "posts"}
                </div>
            )}
            <div style={{ display: "flex", gap: "8px", marginBottom: "16px", flexWrap: "wrap", alignItems: "center" }}>
                <FilterButton label="All Media" type="all" activeFilter={activeFilter} onFilterChange={handleFilterChange} />
                <FilterButton label="Images" type="images" activeFilter={activeFilter} onFilterChange={handleFilterChange} />
                <FilterButton label="GIFs" type="gifs" activeFilter={activeFilter} onFilterChange={handleFilterChange} />
                <FilterButton label="Videos" type="videos" activeFilter={activeFilter} onFilterChange={handleFilterChange} />

                <div className="vc-gallery-date-range" title="Only show media sent within this date range">
                    <input
                        type="date"
                        className="vc-gallery-date-input"
                        aria-label="Media sent on or after this date"
                        value={afterDate}
                        // Reciprocal bounds make an inverted range unselectable, which is cheaper
                        // and clearer than validating it after the fact.
                        max={beforeDate || undefined}
                        onChange={e => commitQueryChange({ afterDate: e.currentTarget.value })}
                    />
                    <span className="vc-gallery-date-sep">→</span>
                    <input
                        type="date"
                        className="vc-gallery-date-input"
                        aria-label="Media sent on or before this date"
                        value={beforeDate}
                        min={afterDate || undefined}
                        onChange={e => commitQueryChange({ beforeDate: e.currentTarget.value })}
                    />
                    {(afterDate || beforeDate) && (
                        <button
                            className="vc-gallery-filter-btn vc-gallery-date-clear"
                            title="Clear date range"
                            onClick={() => commitQueryChange({ afterDate: "", beforeDate: "" })}
                        >×</button>
                    )}
                </div>

                <div style={{ marginLeft: "auto", display: "flex", gap: "6px", alignItems: "center" }}>
                    <input
                        type="range"
                        min={0}
                        max={8}
                        step={1}
                        value={columnSetting}
                        onChange={e => {
                            const val = Number(e.target.value);
                            settings.store.gridColumns = val;
                            setColumnSetting(val);
                        }}
                        className="vc-gallery-col-slider"
                        title="Columns (0 = adaptive)"
                    />
                    <span className="vc-gallery-col-label">{columnSetting === 0 ? "Auto" : columnSetting}</span>
                    <button
                        onClick={() => commitQueryChange({ sortOrder: sortOrder === "desc" ? "asc" : "desc" })}
                        className={`vc-gallery-filter-btn vc-gallery-layout-btn ${sortOrder === "asc" ? "vc-gallery-filter-btn-active" : ""}`}
                        title={sortOrder === "desc" ? "Newest first" : "Oldest first"}
                    >{sortOrder === "desc" ? "↓" : "↑"}</button>
                    <button
                        onClick={() => {
                            settings.store.layoutMode = "grid";
                            setLayoutMode("grid");
                        }}
                        className={`vc-gallery-filter-btn vc-gallery-layout-btn ${layoutMode === "grid" ? "vc-gallery-filter-btn-active" : ""}`}
                        title="Square grid"
                    >⊞</button>
                    <button
                        onClick={() => {
                            settings.store.layoutMode = "masonry";
                            setLayoutMode("masonry");
                        }}
                        className={`vc-gallery-filter-btn vc-gallery-layout-btn ${layoutMode === "masonry" ? "vc-gallery-filter-btn-active" : ""}`}
                        title="Masonry"
                    >⬚</button>
                </div>
            </div>

            {isIndexing && (
                <div style={{
                    backgroundColor: "var(--background-message-automod)",
                    color: "var(--text-normal)",
                    padding: "8px 12px",
                    borderRadius: "8px",
                    marginBottom: "12px",
                    fontSize: "14px",
                    fontWeight: 500,
                    borderLeft: "4px solid var(--info-warning-foreground)",
                }}>
                    Discord is currently indexing this channel's media. This may take a moment...
                </div>
            )}

            <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
                <div style={{ color: "var(--text-muted)", fontSize: "13px" }}>
                    {displayedMedia.length} items loaded{isFetching ? " (loading...)" : ""}
                </div>
                {copyFeedback && (
                    <div style={{ color: "var(--text-positive)", fontSize: "12px", fontWeight: 600 }}>
                        {copyFeedback}
                    </div>
                )}
            </div>

            <div ref={scrollRef} style={{ maxHeight: "60vh", overflowY: "auto" }} onScroll={handleScroll}>
                <div
                    ref={gridRef}
                    className={layoutMode === "masonry" ? "vc-gallery-masonry" : "vc-gallery-grid"}
                    style={({ gridTemplateColumns: layoutMode === "grid" ? `repeat(${effectiveColumns}, minmax(200px, 1fr))` : undefined } as any)}
                >
                    {layoutMode === "masonry"
                        ? masonryColumns.map((column, colIndex) => (
                            <div key={colIndex} className="vc-gallery-masonry-col">
                                {column.map(renderCard)}
                            </div>
                        ))
                        : displayedMedia.map(renderCard)}
                </div>

                <div style={{ display: "flex", justifyContent: "center", margin: "30px 0 10px" }}>
                    {hasMore ? (
                        <button
                            onClick={() => fetchOlderMessages()}
                            disabled={isFetching}
                            style={{
                                padding: "12px 24px",
                                borderRadius: "8px",
                                border: "none",
                                cursor: isFetching ? "not-allowed" : "pointer",
                                backgroundColor: isFetching ? "var(--background-modifier-active)" : "var(--brand-experiment)",
                                color: "white",
                                fontWeight: "bold",
                                fontSize: "16px",
                            }}
                        >
                            {isFetching ? "Loading..." : (sortOrder === "desc" ? "Load Older Messages" : "Load Newer Messages")}
                        </button>
                    ) : (
                        <Text size="md" weight="semibold" style={{ color: "var(--text-muted)" }}>
                            No more media in this channel!
                        </Text>
                    )}
                </div>
            </div>
        </Modal>
    );
}

const FilterButton = ({ label, type, activeFilter, onFilterChange }: { label: string; type: FilterType; activeFilter: FilterType; onFilterChange: (type: FilterType) => void }) => {
    const isActive = activeFilter === type;
    return <button onClick={() => onFilterChange(type)} className={`vc-gallery-filter-btn ${isActive ? "vc-gallery-filter-btn-active" : ""}`}>{label}</button>;
};

type GalleryTarget = {
    channel: Channel;
    forumScope?: ForumScope; // set when aggregating every thread of a forum
};

function getGalleryTarget({ channel, thread }: { channel?: Channel; thread?: Channel; }): GalleryTarget | null {
    if (thread) return { channel: thread };
    if (!channel) return null;

    // A regular (non-forum) channel keeps the original single-channel behaviour. Threads inside
    // it stay their own galleries — merging them here would change behaviour for every text
    // channel in the client, not just forums.
    if (!channel.isForumLikeChannel?.()) return { channel };

    // Media channels have no thread list; only forum channels aggregate. A forum with no active
    // threads falls back to its own channel (header messages still count as content).
    if (!channel.guild_id || channel.type !== 15) return { channel };

    const threadIds: string[] = [channel.id];
    const threadNames: Record<string, string> = {};
    for (const t of Object.values(ChannelStore.getMutableGuildChannelsForGuild(channel.guild_id) ?? {}) as Channel[]) {
        if (t.isThread?.() && t.parent_id === channel.id) {
            threadIds.push(t.id);
            threadNames[t.id] = t.name;
        }
    }

    return threadIds.length > 1
        ? { channel, forumScope: { channelIds: threadIds, threadNames, threadCount: threadIds.length - 1 } }
        : { channel };
}

function patchGalleryContextMenu(children: Array<React.ReactElement | null>, args: { channel?: Channel; thread?: Channel; }) {
    const target = getGalleryTarget(args);
    if (!target) return;

    const group = findGroupChildrenByChildId("mark-channel-read", children) ?? children;
    group.push(
        <Menu.MenuItem
            id="vc-gallery-open"
            label="Open Gallery View"
            action={() => openModal(props => (
                <ErrorBoundary>
                    <GalleryModal modalProps={props} channel={target.channel} forumScope={target.forumScope} />
                </ErrorBoundary>
            ))}
        />
    );
}

export default definePlugin({
    name: "GalleryMode",
    managedStyle: style,
    description: "Infinitely scrolling media gallery with filtering and message context jumping.",
    tags: ["Media", "Utility"],
    searchTerms: ["gallery", "media", "images", "videos", "gif"],
    authors: [{ name: "Sodroz", id: 145188106289545216n }],
    settings,
    contextMenus: {
        "channel-context": patchGalleryContextMenu,
        "thread-context": patchGalleryContextMenu,
    },
});
