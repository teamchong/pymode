"""Pillow operations backend — called by @pymode/pillow TypeScript API.

Each function receives image data as base64 and returns results as JSON.
The TypeScript layer handles serialization/deserialization.
"""

import base64
import io
from PIL import Image

RESAMPLE_FILTERS = {
    'nearest': Image.NEAREST,
    'bilinear': Image.BILINEAR,
    'bicubic': Image.BICUBIC,
    'lanczos': Image.LANCZOS,
}


def _image_info(img):
    return {
        'width': img.width,
        'height': img.height,
        'format': (img.format or 'png').lower(),
        'mode': img.mode,
    }


def _image_to_b64(img, fmt='PNG', **save_kwargs):
    buf = io.BytesIO()
    img.save(buf, format=fmt.upper(), **save_kwargs)
    return base64.b64encode(buf.getvalue()).decode('ascii')


def _load_image(image_b64):
    raw = base64.b64decode(image_b64)
    return Image.open(io.BytesIO(raw))


def open(*, image_b64, **_):
    img = _load_image(image_b64)
    return _image_info(img)


def resize(*, image_b64, width, height, filter='lanczos', **_):
    img = _load_image(image_b64)
    resample = RESAMPLE_FILTERS.get(filter, Image.LANCZOS)
    result = img.resize((int(width), int(height)), resample)
    fmt = img.format or 'PNG'
    return {
        'image_b64': _image_to_b64(result, fmt),
        'info': _image_info(result),
    }


def crop(*, image_b64, left, top, right, bottom, **_):
    img = _load_image(image_b64)
    result = img.crop((int(left), int(top), int(right), int(bottom)))
    fmt = img.format or 'PNG'
    return {
        'image_b64': _image_to_b64(result, fmt),
        'info': _image_info(result),
    }


def rotate(*, image_b64, degrees, expand=False, **_):
    img = _load_image(image_b64)
    result = img.rotate(float(degrees), expand=bool(expand))
    fmt = img.format or 'PNG'
    return {
        'image_b64': _image_to_b64(result, fmt),
        'info': _image_info(result),
    }


def flip(*, image_b64, direction, **_):
    img = _load_image(image_b64)
    if direction == 'horizontal':
        result = img.transpose(Image.FLIP_LEFT_RIGHT)
    elif direction == 'vertical':
        result = img.transpose(Image.FLIP_TOP_BOTTOM)
    else:
        raise ValueError(f"Unknown flip direction: {direction}")
    fmt = img.format or 'PNG'
    return {
        'image_b64': _image_to_b64(result, fmt),
        'info': _image_info(result),
    }


def convert(*, image_b64, mode, **_):
    img = _load_image(image_b64)
    result = img.convert(mode)
    fmt = img.format or 'PNG'
    return {
        'image_b64': _image_to_b64(result, fmt),
        'info': _image_info(result),
    }


def thumbnail(*, image_b64, max_width, max_height, **_):
    img = _load_image(image_b64)
    img.thumbnail((int(max_width), int(max_height)), Image.LANCZOS)
    fmt = img.format or 'PNG'
    return {
        'image_b64': _image_to_b64(img, fmt),
        'info': _image_info(img),
    }


def export(*, image_b64, format='png', quality=None, optimize=False, lossless=False, **_):
    img = _load_image(image_b64)
    save_kwargs = {}
    fmt = format.upper()
    if quality is not None:
        save_kwargs['quality'] = int(quality)
    if optimize:
        save_kwargs['optimize'] = True
    if lossless and fmt == 'WEBP':
        save_kwargs['lossless'] = True
    return {
        'image_b64': _image_to_b64(img, fmt, **save_kwargs),
    }
