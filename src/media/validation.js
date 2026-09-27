import { createHash } from 'node:crypto';

export class MediaFailure extends Error {
    constructor(code) { super(code); this.code = code; }
}

const SIGNATURES = [
    ['image/jpeg', 'jpeg', b => b.length >= 4 && b[0] === 0xff && b[1] === 0xd8],
    ['image/png', 'png', b => b.length >= 24 && b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))],
    ['image/webp', 'webp', b => b.length >= 20 && b.toString('ascii', 0, 4) === 'RIFF'
        && b.toString('ascii', 8, 12) === 'WEBP' && b.readUInt32LE(4) + 8 === b.length],
    ['image/gif', 'gif', b => b.length >= 14 && ['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6))],
];

function hasApngChunk(bytes) {
    let offset = 8;
    let imageData = false;
    while (offset + 12 <= bytes.length) {
        const size = bytes.readUInt32BE(offset);
        if (size > bytes.length - offset - 12) throw new MediaFailure('INVALID_MEDIA');
        const name = bytes.toString('ascii', offset + 4, offset + 8);
        if (name === 'acTL') return true;
        if (name === 'IDAT') imageData = true;
        offset += size + 12;
        if (name === 'IEND') {
            if (size !== 0 || !imageData || offset !== bytes.length) throw new MediaFailure('INVALID_MEDIA');
            return false;
        }
    }
    throw new MediaFailure('INVALID_MEDIA');
}

export async function validateImage(bytes, declared, policy, sharp) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 16 || bytes.length > policy.maxBytes)
        throw new MediaFailure('MEDIA_TOO_LARGE');
    const found = SIGNATURES.find(([, , check]) => check(bytes));
    if (!found) throw new MediaFailure('UNSUPPORTED_MEDIA_TYPE');
    const [mime, format] = found;
    if (format === 'jpeg' && (bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9))
        throw new MediaFailure('INVALID_MEDIA');
    if (format === 'gif' && bytes.at(-1) !== 0x3b) throw new MediaFailure('INVALID_MEDIA');
    const supplied = String(declared || '').split(';')[0].trim().toLowerCase();
    if (supplied && supplied !== mime && supplied !== 'application/octet-stream')
        throw new MediaFailure('MIME_MISMATCH');
    // The current profile accepts animated GIF. APNG and animated WebP are rejected explicitly
    // until their full-frame validation is covered on the deployed decoder.
    if (format === 'png' && hasApngChunk(bytes)) throw new MediaFailure('ANIMATION_UNSUPPORTED');
    if (format === 'webp' && bytes.toString('ascii', 12, 16) === 'VP8X' && (bytes[20] & 0x02))
        throw new MediaFailure('ANIMATION_UNSUPPORTED');
    try {
        const input = () => sharp(bytes, { animated: format === 'gif', failOn: 'warning',
            limitInputPixels: policy.maxFramePixels });
        // Metadata parsing does not decode pixels. Bound dimensions before any full decode.
        const metadata = await sharp(bytes, { animated: format === 'gif', failOn: 'warning',
            limitInputPixels: false }).metadata();
        const width = metadata.width, height = metadata.pageHeight || metadata.height;
        const frames = metadata.pages || 1;
        if (metadata.format !== format || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
            || width < 1 || height < 1) throw new MediaFailure('INVALID_MEDIA');
        if (width > policy.maxDimension || height > policy.maxDimension || width * height > policy.maxPixels
            || frames > policy.maxFrames || width * height * frames > policy.maxFramePixels)
            throw new MediaFailure('MEDIA_COMPLEXITY_EXCEEDED');
        // Decode every frame under a bounded aggregate-pixel budget. Metadata alone does not
        // prove that the compressed original is complete or structurally decodable.
        await input().raw().toBuffer();
        let thumbnail = null;
        try {
            thumbnail = await sharp(bytes, { page: 0, pages: 1, failOn: 'warning',
                limitInputPixels: policy.maxPixels }).rotate().resize({ width: 512, height: 512,
                fit: 'inside', withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
        } catch { /* Original remains valid; derived can be rebuilt later. */ }
        return { mime, format, width, height, frames, animated: frames > 1,
            digest: createHash('sha256').update(bytes).digest('hex'), thumbnail };
    } catch (error) {
        if (error instanceof MediaFailure) throw error;
        throw new MediaFailure('INVALID_MEDIA');
    }
}
