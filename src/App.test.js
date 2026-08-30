import { fireEvent, render, screen } from '@testing-library/react';
import App, { RoomViewerScreen } from './App';

beforeEach(() => {
  window.history.replaceState({}, '', '/?mobilePreview=1');
  HTMLCanvasElement.prototype.getContext = jest.fn(() => null);
});

afterEach(() => {
  window.history.replaceState({}, '', '/');
});

test('starts with a scan action and no progress UI', () => {
  render(<App />);
  expect(screen.getByRole('button', { name: /start scan/i })).toBeInTheDocument();
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  expect(screen.queryByText(/\d+%/)).not.toBeInTheDocument();
});

test('opens the camera with a user-controlled finish action and no fake geometry layer', () => {
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: /start scan/i }));
  expect(screen.getByRole('button', { name: 'Done scanning' })).toBeEnabled();
  expect(screen.getByText(/Camera capture active/i)).toBeInTheDocument();
  expect(screen.getByText(/3D room will be built after processing/i)).toBeInTheDocument();
  expect(screen.getByText(/Allow camera access/i)).toBeInTheDocument();
  expect(document.querySelector('.surface-sticker-canvas')).not.toBeInTheDocument();
  expect(document.querySelector('.coverage-canvas')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Directional room coverage map')).not.toBeInTheDocument();
  expect(screen.queryByText('Adaptive scan guide')).not.toBeInTheDocument();
  expect(screen.queryByText(/views saved/i)).not.toBeInTheDocument();
});

test('does not silently stay on starting camera when camera access is unavailable', () => {
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: /start scan/i }));
  expect(screen.getByRole('alert')).toHaveTextContent(/allow camera access/i);
  expect(screen.getByRole('button', { name: 'Done scanning' })).toBeEnabled();
});

test('pause stops capture controls without removing the live camera surface', () => {
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: /start scan/i }));
  const video = document.querySelector('video');
  fireEvent.click(screen.getByRole('button', { name: 'Pause scan' }));
  expect(screen.getByRole('button', { name: /resume/i })).toBeInTheDocument();
  expect(document.querySelector('video')).toBe(video);
});

test('viewer refuses to manufacture a local 3D room', () => {
  render(<RoomViewerScreen selectedKeyframes={[{ thumbnail: 'data:image/jpeg;base64,room' }]} onBack={() => {}} />);
  expect(screen.getByRole('alert')).toHaveTextContent(/no 3d model was produced/i);
  expect(screen.queryByLabelText(/measurement/i)).not.toBeInTheDocument();
});

test('viewer embeds only a reconstruction service result', () => {
  render(<RoomViewerScreen selectedKeyframes={[]} reconstruction={{ viewerUrl: 'https://viewer.example.test/room/1' }} onBack={() => {}} />);
  expect(screen.getByTitle('Reconstructed 3D room viewer')).toHaveAttribute('src', 'https://viewer.example.test/room/1');
});

test('keeps live scanning unavailable when no camera API exists', () => {
  window.history.replaceState({}, '', '/');
  render(<App />);
  expect(screen.queryByRole('button', { name: /start scan/i })).not.toBeInTheDocument();
  expect(screen.getByText('Open PolyScan on your phone')).toBeInTheDocument();
});

test('exposes the scanner to a desktop browser with a webcam API', () => {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: jest.fn() },
  });
  window.history.replaceState({}, '', '/');
  render(<App />);
  expect(screen.getByRole('button', { name: /start scan/i })).toBeInTheDocument();
});
