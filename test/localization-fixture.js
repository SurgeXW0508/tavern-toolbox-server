import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';

export async function card(filename, date, name = 'A') {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3,
        background: '#337799' } }).png().toBuffer();
    const payload = Buffer.from(`chara\0${Buffer.from(JSON.stringify({ name, create_date: date })).toString('base64')}`);
    const chunk = Buffer.alloc(payload.length + 12);
    chunk.writeUInt32BE(payload.length, 0); chunk.write('tEXt', 4); payload.copy(chunk, 8);
    let crc = 0xffffffff;
    for (const byte of chunk.subarray(4, -4)) {
        crc ^= byte;
        for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
    await writeFile(filename, Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]));
}
