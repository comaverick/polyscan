import { normalizeFormat } from './RoomModelViewer';

test('detects reconstructed model formats from explicit metadata or URLs', () => {
  expect(normalizeFormat({ url: 'https://models.example.test/room.glb' })).toBe('glb');
  expect(normalizeFormat({ url: 'https://models.example.test/room.ply?token=one' })).toBe('ply');
  expect(normalizeFormat({ url: 'room.bin', format: '.gltf' })).toBe('gltf');
});
