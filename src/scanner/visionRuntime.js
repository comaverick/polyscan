let runtimePromise;
const OPENCV_SCRIPT_URL = 'https://docs.opencv.org/4.12.0/opencv.js';

export function loadVisionRuntime() {
  if (!runtimePromise) {
    runtimePromise = new Promise((resolve, reject) => {
      const ready = () => {
        const runtime = window.cv;
        if (!runtime) {
          reject(new Error('OpenCV did not load'));
          return;
        }
        if (runtime.Mat) {
          resolve(runtime);
          return;
        }
        runtime.onRuntimeInitialized = () => resolve(runtime);
      };
      if (window.cv) {
        ready();
        return;
      }
      const script = document.createElement('script');
      script.async = true;
      script.src = OPENCV_SCRIPT_URL;
      script.onload = ready;
      script.onerror = () => reject(new Error('OpenCV could not be downloaded'));
      document.head.appendChild(script);
    });
  }
  return runtimePromise;
}

export function createVisionFrame(cv, imageData) {
  const source = cv.matFromImageData(imageData);
  const gray = new cv.Mat();
  try {
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
    return gray;
  } finally {
    source.delete();
  }
}

export function trackPointsWithVision(cv, previousGray, currentRgba, width, height, points = []) {
  if (!cv || !previousGray || points.length < 3) return null;
  const source = cv.matFromImageData(currentRgba);
  const currentGray = new cv.Mat();
  const previousPoints = cv.matFromArray(
    points.length,
    1,
    cv.CV_32FC2,
    points.flatMap((point) => [point.x * width, point.y * height]),
  );
  const nextPoints = new cv.Mat();
  const status = new cv.Mat();
  const error = new cv.Mat();
  let keepCurrentFrame = false;
  try {
    cv.cvtColor(source, currentGray, cv.COLOR_RGBA2GRAY);
    cv.calcOpticalFlowPyrLK(
      previousGray,
      currentGray,
      previousPoints,
      nextPoints,
      status,
      error,
      new cv.Size(21, 21),
      3,
      new cv.TermCriteria(cv.TermCriteria_COUNT + cv.TermCriteria_EPS, 20, 0.03),
    );
    const next = nextPoints.data32F;
    const flags = status.data;
    const errors = error.data32F;
    const tracked = points.map((point, index) => {
      if (!flags[index] || errors[index] > 22) return null;
      const x = next[index * 2] / width;
      const y = next[index * 2 + 1] / height;
      if (x < -0.05 || x > 1.05 || y < -0.05 || y > 1.05) return null;
      return { ...point, x, y, confidence: Math.max(0.32, (point.confidence || 0.7) * 0.9) };
    }).filter(Boolean);
    keepCurrentFrame = true;
    return { currentGray, points: tracked };
  } finally {
    source.delete();
    previousPoints.delete();
    nextPoints.delete();
    status.delete();
    error.delete();
    if (!keepCurrentFrame) currentGray.delete();
  }
}
