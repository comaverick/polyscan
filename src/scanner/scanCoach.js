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

export function getScanCoachAdvice({ directionalCoverage, keyframes = 0, evidence = {}, trackingState = 'searching' } = {}) {
  const lower = coverageByBand(directionalCoverage, 2);
  const upper = coverageByBand(directionalCoverage, 0);
  const middle = coverageByBand(directionalCoverage, 1);
  const missingWall = weakestWall(directionalCoverage);

  if (trackingState === 'lost') {
    return { title: 'Find detail', instruction: 'Point at a corner, doorway, or furniture edge. Hold still, then take three slow side steps.', reason: 'PolyScan needs visible detail to compare views.' };
  }
  if (keyframes < 3) {
    return { title: 'Start at one corner', instruction: 'Frame a wall corner with furniture or a doorway. Move slowly sideways until three views are saved.', reason: 'Corners give the scan a stable starting reference.' };
  }
  if ((evidence.parallax || 0) < 0.045) {
    return { title: 'Create depth', instruction: 'Keep the same scene on screen and take three steps sideways. Do not only rotate in place.', reason: 'Sideways movement lets the 3D model measure depth.' };
  }
  if (lower < 0.22) {
    return { title: 'Capture the floor', instruction: 'Tilt down and walk slowly across the floor. Keep a wall edge in the top of the frame.', reason: 'The floor is still missing from the room model.' };
  }
  if (upper < 0.22) {
    return { title: 'Capture the ceiling', instruction: 'Tilt up and slowly pan across the ceiling. Keep a wall edge in the bottom of the frame.', reason: 'The ceiling is still missing from the room model.' };
  }
  if (missingWall.coverage < 0.42 || middle < 0.42) {
    return { title: 'Cover another wall', instruction: `Turn toward ${DIRECTION_NAMES[missingWall.wallIndex]} and walk along it slowly. Keep the previous corner in view.`, reason: 'This wall needs more overlapping views.' };
  }
  if (keyframes < 28) {
    return { title: 'Capture room details', instruction: 'Walk around large furniture. Capture the front and both sides of each object.', reason: 'Extra viewpoints improve furniture and object shape.' };
  }
  return { title: 'Room coverage looks good', instruction: 'Make one final slow pass around any area you skipped, then finish the scan.', reason: 'You have broad coverage across the room.' };
}
