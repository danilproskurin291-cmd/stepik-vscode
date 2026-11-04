/**
 * Uploadcare proxy used by stepik.org for comment images.
 *
 * The browser client obtains these constants from the page globals
 * (`UPLOADCARE_PUBLIC_KEY`, `UPLOADCARE_URL_BASE`, `UPLOADCARE_CDN_BASE`).
 * They are public and are also embedded in the CKEditor upload plugin.
 */
const UPLOADCARE_PUBLIC_KEY = 'e7a075ad8dc9e3a1ec61';
const UPLOADCARE_UPLOAD_BASE = 'https://upload.uploadcare.stepik.net/';
const UPLOADCARE_CDN_BASE = 'https://ucarecdn.stepik.net/';
const UPLOAD_TIMEOUT_MS = 60_000;

export interface UploadedCommentImage {
    id: string;
    url: string;
    width?: number;
    height?: number;
    name?: string;
    mimeType?: string;
    size?: number;
}

async function fetchWithTimeout(
    url: string,
    init: RequestInit = {},
    timeoutMs: number = UPLOAD_TIMEOUT_MS
): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
        if (controller.signal.aborted) {
            throw new Error(`Загрузка изображения не завершилась за ${Math.round(timeoutMs / 1000)} с.`);
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Upload an image to the Stepik Uploadcare proxy and return a ready-to-use
 * CDN URL. Stepik's own editor inserts `<img src="<cdnUrl>">` into comment HTML.
 */
export async function uploadCommentImage(
    data: Uint8Array,
    fileName: string,
    mimeType: string
): Promise<UploadedCommentImage> {
    const form = new FormData();
    form.append('UPLOADCARE_PUB_KEY', UPLOADCARE_PUBLIC_KEY);
    form.append('UPLOADCARE_STORE', '1');
    // Copy into an ArrayBuffer-backed view so the Blob constructor accepts the
    // data under TypeScript's generic TypedArray definitions.
    const bytes = new Uint8Array(data.byteLength);
    bytes.set(data);
    form.append(
        'file',
        new Blob([bytes], { type: mimeType || 'application/octet-stream' }),
        fileName || 'image.png'
    );

    const response = await fetchWithTimeout(`${UPLOADCARE_UPLOAD_BASE}base/`, {
        method: 'POST',
        body: form
    });
    if (!response.ok) {
        throw new Error(`Uploadcare вернул HTTP ${response.status} ${response.statusText}`);
    }

    const uploaded = (await response.json()) as { file?: string; error?: string };
    if (!uploaded.file) {
        throw new Error(uploaded.error || 'Uploadcare не вернул идентификатор файла.');
    }

    const id = uploaded.file;
    const result: UploadedCommentImage = {
        id,
        url: `${UPLOADCARE_CDN_BASE}${id}/`,
        name: fileName
    };

    try {
        const infoResponse = await fetchWithTimeout(
            `${UPLOADCARE_UPLOAD_BASE}info/?pub_key=${encodeURIComponent(
                UPLOADCARE_PUBLIC_KEY
            )}&file_id=${encodeURIComponent(id)}`
        );
        if (infoResponse.ok) {
            const info = (await infoResponse.json()) as {
                image_info?: { width?: number; height?: number };
                mime_type?: string;
                size?: number;
                original_filename?: string;
            };
            result.width = info.image_info?.width;
            result.height = info.image_info?.height;
            result.mimeType = info.mime_type;
            result.size = info.size;
            result.name = info.original_filename || result.name;
        }
    } catch {
        // Dimensions are optional: the image still renders without them.
    }

    return result;
}
