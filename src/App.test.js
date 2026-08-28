import { fireEvent, render, screen } from '@testing-library/react';
import App, { RoomViewerScreen } from './App';

beforeEach(() => {
  window.history.replaceState({}, '', '/?mobilePreview=1');
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

test('opens the camera surface with an initial blue state and disabled Done action', () => {
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: /start scan/i }));
  expect(screen.getByRole('button', { name: /done scanning, waiting/i })).toBeDisabled();
  expect(screen.getByText('Move around the room')).toBeInTheDocument();
  expect(document.querySelector('.coverage-canvas')).toHaveAttribute('data-coverage-state', 'initial-blue');
  expect(screen.queryByLabelText('Directional room coverage map')).not.toBeInTheDocument();
});

test('does not silently stay on starting camera when camera access is unavailable', () => {
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: /start scan/i }));
  expect(screen.getByRole('alert')).toHaveTextContent(/camera access is needed/i);
  expect(screen.getByText(/preview only/i)).toBeInTheDocument();
});

test('pause stops capture controls without removing the live camera surface', () => {
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: /start scan/i }));
  const video = document.querySelector('video');
  fireEvent.click(screen.getByRole('button', { name: /pause/i }));
  expect(screen.getByRole('button', { name: /resume/i })).toBeInTheDocument();
  expect(document.querySelector('video')).toBe(video);
});

test('viewer measurement tool lets the user place and confirm a distance', () => {
  render(<RoomViewerScreen selectedKeyframes={[{ thumbnail: 'data:image/jpeg;base64,room' }]} onBack={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Measure' }));
  const stage = screen.getByRole('region', { name: 'Room measurement tool' });
  Object.defineProperty(stage, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 100, height: 100 }) });
  fireEvent.click(stage, { clientX: 20, clientY: 30 });
  expect(screen.getByText('Tap the second point.')).toBeInTheDocument();
  fireEvent.click(stage, { clientX: 80, clientY: 70 });
  fireEvent.change(screen.getByLabelText('Real distance'), { target: { value: '3.2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm measurement' }));
  expect(screen.getByText('3.2 m confirmed')).toBeInTheDocument();
});

test('keeps live scanning unavailable on desktop browsers', () => {
  window.history.replaceState({}, '', '/');
  render(<App />);
  expect(screen.queryByRole('button', { name: /start scan/i })).not.toBeInTheDocument();
  expect(screen.getByText('Open PolyScan on your phone')).toBeInTheDocument();
});
