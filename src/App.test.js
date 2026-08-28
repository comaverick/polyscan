import { fireEvent, render, screen } from '@testing-library/react';
import App from './App';

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
});

test('pause stops capture controls without removing the live camera surface', () => {
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: /start scan/i }));
  const video = document.querySelector('video');
  fireEvent.click(screen.getByRole('button', { name: /pause/i }));
  expect(screen.getByRole('button', { name: /resume/i })).toBeInTheDocument();
  expect(document.querySelector('video')).toBe(video);
});
