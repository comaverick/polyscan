const DEFAULT_MAX_EDGE = 1600;
const DEFAULT_JPEG_QUALITY = 0.9;

export function getCaptureDimensions(width, height, maximumEdge = DEFAULT_MAX_EDGE) {
  const sourceWidth = Math.max(1, Number(width) || 1);
  const sourceHeight = Math.max(1, Number(height) || 1);
  const scale = Math.min(1, maximumEdge / Math.max(sourceWidth, sourceHeight));
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}

export function captureVideoKeyframe(video, options = {}) {
  const width = Number(video?.videoWidth || 0);
  const height = Number(video?.videoHeight || 0);
  if (!video || width < 2 || height < 2) return Promise.resolve(null);

  const dimensions = getCaptureDimensions(width, height, options.maximumEdge || DEFAULT_MAX_EDGE);
  const canvas = document.createElement('canvas');
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) return Promise.resolve(null);

  context.drawImage(video, 0, 0, dimensions.width, dimensions.height);
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (!blob?.size) {
        resolve(null);
        return;
      }
      resolve({ blob, ...dimensions, contentType: blob.type || 'image/jpeg' });
    }, 'image/jpeg', options.quality || DEFAULT_JPEG_QUALITY);
  });
}

export async function resolveKeyframeAssets(keyframes = []) {
  const resolved = await Promise.all((keyframes || []).map(async (keyframe) => {
    let capture = keyframe.capture || null;
    if (!capture && keyframe.capturePromise) {
      try {
        capture = await keyframe.capturePromise;
      } catch {
        capture = null;
      }
    }
    const { capturePromise, ...serializable } = keyframe;
    return capture?.blob ? { ...serializable, capture } : serializable;
  }));
  return resolved;
}

export function countCapturedKeyframes(keyframes = []) {
  return (keyframes || []).filter((keyframe) => Boolean(keyframe.capture?.blob)).length;
}
