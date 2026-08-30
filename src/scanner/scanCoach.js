const DIRECTION_NAMES = ['the next wall', 'the wall to your right', 'the wall behind you', 'the wall to your left'];

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function coverageByBand(cells, pitchBand) {
  return average((cells || []).filter((cell) => cell.pitchBand === pitchBand).map((cell) => cell.coverage || 0));
}

function weakestWall(cells) {
  const walls = [0, 1, 2, 3].map((wallIndex) => {
    const cellsForWall = (cells || []).filter((cell) => Math.floor(cell.yawIndex / 5) === wallIndex);
    return { wallIndex, coverage: average(cellsForWall.map((cell) => cell.coverage || 0)) };
  });
  return walls.sort((first, second) => first.coverage - second.coverage)[0] || { wallIndex: 0, coverage: 0 };
}

export function getScanCoachAdvice({ directionalCoverage, keyframes = 0, trackingState = 'searching' } = {}) {
  const lower = coverageByBand(directionalCoverage, 2);
  const upper = coverageByBand(directionalCoverage, 0);
  const missingWall = weakestWall(directionalCoverage);

  if (trackingState === 'lost') {
    return { title: 'Find detail', instruction: 'Point at a corner, doorway, or furniture edge. Hold still, then take three slow side steps.', reason: 'PolyScan needs visible detail to compare views.' };
  }
  // Keep each phase long enough for someone to physically follow it. Coverage
  // is used within a phase, instead of letting one noisy frame redirect the user.
  if (keyframes < 4) {
    return { title: 'Start at one corner', instruction: 'Frame a wall corner with furniture or a doorway. Move slowly sideways until four views are saved.', reason: 'Corners give the scan a stable starting reference.' };
  }
  if (keyframes < 10) {
    return { title: 'Create depth', instruction: 'Keep the same scene on screen and take three steps sideways. Do not only rotate in place.', reason: 'Sideways movement lets the 3D model measure depth.' };
  }
  if (keyframes < 16) {
    return { title: 'Cover the room perimeter', instruction: `Turn toward ${DIRECTION_NAMES[missingWall.wallIndex]} and walk along it slowly. Keep the previous corner in view.`, reason: 'Build overlapping views of the walls before changing height.' };
  }
  if (keyframes < 21 && lower < 0.22) {
    return { title: 'Capture the floor', instruction: 'Tilt down and walk slowly across the floor. Keep a wall edge in the top of the frame.', reason: 'The floor is still missing from the room model.' };
  }
  if (keyframes < 26 && upper < 0.22) {
    return { title: 'Capture the ceiling', instruction: 'Tilt up and slowly pan across the ceiling. Keep a wall edge in the bottom of the frame.', reason: 'The ceiling is still missing from the room model.' };
  }
  if (keyframes < 26) {
    return { title: 'Complete the room shell', instruction: `Return to ${DIRECTION_NAMES[missingWall.wallIndex]} and make one slow pass at a new height.`, reason: 'The floor or ceiling already has enough coverage; fill the remaining wall views.' };
  }
  if (keyframes < 34) {
    return { title: 'Capture room details', instruction: 'Walk around large furniture. Capture the front and both sides of each object.', reason: 'Extra viewpoints improve furniture and object shape.' };
  }
  return { title: 'Room coverage looks good', instruction: 'Make one final slow pass around any area you skipped, then finish the scan.', reason: 'You have broad coverage across the room.' };
}

export function getLiveScanAdvice({
  cameraState = 'idle',
  trackingState = 'searching',
  keyframes = 0,
  visibleDetailCount = 0,
  evidence,
  recording = false,
  surfaceLocked = false,
} = {}) {
  if (cameraState === 'requesting') {
    return { state: 'camera', label: 'Allow camera', title: 'Allow camera access', instruction: 'Choose Allow so PolyScan can see the room.', reason: 'The camera preview is required before PolyScan can compare surfaces.' };
  }
  if (cameraState !== 'live') {
    return { state: 'camera', label: 'Camera unavailable', title: 'Camera unavailable', instruction: 'Reconnect the camera, then try again.', reason: 'A live preview is needed to save trustworthy room views.' };
  }
  if (!recording) {
    return { state: 'ready', label: 'Ready', title: 'Tap record to begin', instruction: 'Tap the center button once, then move slowly to start mapping.', reason: 'PolyScan waits for your tap before saving viewpoints.' };
  }
  if (visibleDetailCount < 8) {
    return { state: 'detail', label: 'Find detail', title: 'Find visual detail', instruction: 'Aim at a corner, edge, pattern, or piece of furniture.', reason: 'Edges and texture give the mapper something stable to follow.' };
  }
  if (trackingState === 'lost' || !evidence?.tracking) {
    return { state: 'lost', label: 'Tracking lost', title: 'Find the last surface', instruction: 'Slow down and point back at the last detailed surface.', reason: 'Return to the last confirmed detail so the map can relocalize.' };
  }
  if (evidence?.tooFast) {
    return { state: 'fast', label: 'Slow down', title: 'Slow down', instruction: 'Move the phone more slowly so the surface can be measured.', reason: 'Fast motion causes blur and unreliable feature matches.' };
  }
  if (evidence?.usefulViewpoint) {
    return {
      state: 'confirmed',
      label: surfaceLocked ? 'Surface confirmed' : 'View confirmed',
      title: surfaceLocked ? 'Surface confirmed' : 'View confirmed',
      instruction: 'Good overlap. Continue slowly and keep part of the previous view visible.',
      reason: 'This view overlaps the map, so it can contribute to the room model.',
    };
  }
  if (keyframes === 0) {
    return { state: 'start', label: 'Move to start', title: 'Move device to start', instruction: 'Hold a corner in view, then make a slow sideways move.', reason: 'A controlled first move gives the mapper a reliable baseline.' };
  }
  return { state: 'tracking', label: 'Tracking', title: 'Hold this surface', instruction: 'Keep the same details in view and move gently sideways.', reason: 'Sideways overlap helps estimate depth instead of only rotating in place.' };
}
