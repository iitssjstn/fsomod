"""Genereert icon_TwitchSabotage.dds (256x256, ongecomprimeerd BGRA) zonder externe libraries."""
import struct
import sys

SIZE = 256


def pixel(x, y):
    cx, cy = x - SIZE / 2, y - SIZE / 2
    d2 = cx * cx + cy * cy
    # achtergrond: donkergroen verloop
    g = int(60 + 60 * y / SIZE)
    r, g_, b = 20, g, 30
    # paarse cirkel (Twitch)
    if d2 < 95 ** 2:
        r, g_, b = 145, 71, 255
    # wit "bliksem"-icoon
    if 80 < y < 176:
        t = (y - 80) / 96
        left = 128 - 10 + int(30 * (0.5 - abs(t - 0.5)) * 2) - (20 if t > 0.5 else 0)
        if left <= x <= left + 26:
            r, g_, b = 255, 255, 255
    return bytes((b, g_, r, 255))


def main(out):
    header = bytearray(128)
    struct.pack_into('<4s', header, 0, b'DDS ')
    struct.pack_into('<7I', header, 4, 124, 0x1 | 0x2 | 0x4 | 0x1000 | 0x8, SIZE, SIZE, SIZE * 4, 0, 1)
    # pixelformat op offset 76
    struct.pack_into('<8I', header, 76, 32, 0x41, 0, 32, 0x00FF0000, 0x0000FF00, 0x000000FF, 0xFF000000)
    struct.pack_into('<I', header, 108, 0x1000)  # caps: texture
    data = b''.join(pixel(x, y) for y in range(SIZE) for x in range(SIZE))
    with open(out, 'wb') as f:
        f.write(header)
        f.write(data)


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'icon_TwitchSabotage.dds')
