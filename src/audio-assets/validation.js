import { AUDIO_MIME } from '../network/audio-profile.js';
export const canonicalAudioMime = mime => ['audio/wave', 'audio/x-wav'].includes(mime) ? 'audio/wav' : mime;

// Container/header validation without a decoder or transcoder. Codec support
// remains the browser's responsibility. Only finite Audio profile files enter.
export function audioSignature(mime, bytes, total = bytes.length) {
    if (!AUDIO_MIME.includes(mime) || bytes.length < 4) return false;
    const ascii = (at, text) => bytes.subarray(at, at + text.length).toString('ascii') === text;
    if (mime === 'audio/mpeg') {
        if (ascii(0, 'ID3')) {
            if (bytes.length < 10 || ![2, 3, 4].includes(bytes[3]) || bytes[4] === 255 || bytes.subarray(6, 10).some(byte => byte >= 128)) return false;
            const tagBytes = ((bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9]) + 10;
            return tagBytes < total; // finite tag, some audio data follows
        }
        return bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x18) !== 0x08
            && (bytes[1] & 6) !== 0 && (bytes[2] >> 4) !== 15 && (bytes[2] & 12) !== 12;
    }
    if (mime === 'audio/aac') return bytes.length >= 7 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0;
    if (mime === 'audio/mp4') return bytes.length >= 16 && ascii(4, 'ftyp') && bytes.readUInt32BE(0) >= 16 && bytes.readUInt32BE(0) <= total;
    if (mime === 'audio/ogg') return bytes.length >= 27 && ascii(0, 'OggS') && bytes[4] === 0;
    if (mime === 'audio/webm') return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    return bytes.length >= 12 && ascii(0, 'RIFF') && ascii(8, 'WAVE') && bytes.readUInt32LE(4) + 8 <= total;
}
