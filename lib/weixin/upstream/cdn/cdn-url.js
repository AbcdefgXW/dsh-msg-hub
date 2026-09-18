/**
 * Unified CDN URL construction for Weixin CDN upload/download.
 */
/** 设为 true 时，当服务端未返回 full_url 字段，回退到客户端拼接 URL；false 则直接报错。 */
export const ENABLE_CDN_URL_FALLBACK = true;
/** Build a CDN download URL from encrypt_query_param. */
export function buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl) {
    return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}
/** Build a CDN upload URL from upload_param and filekey. */
export function buildCdnUploadUrl(params) {
    return `${params.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(params.uploadParam)}&filekey=${encodeURIComponent(params.filekey)}`;
}
//# sourceMappingURL=cdn-url.js.map