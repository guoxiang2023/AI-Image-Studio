let secretBox = null;
// Set only by the Electron entry point. Reading a user's local directory is a
// desktop capability; a networked deployment must never inherit it.
let desktopWorkspace = false;
let dummyPasswordHash = '';
let desktopUpdater = null;

export function setSecretBox(value) {
  secretBox = value;
}

export function getSecretBox() {
  if (!secretBox) throw new Error('secret box 尚未初始化');
  return secretBox;
}

export function setDummyPasswordHash(value) {
  dummyPasswordHash = value;
}

export function getDummyPasswordHash() {
  return dummyPasswordHash;
}

export function setDesktopUpdater(value) {
  desktopUpdater = value;
}

export function getDesktopUpdater() {
  return desktopUpdater;
}

export function setDesktopWorkspace(value) {
  desktopWorkspace = Boolean(value);
}

export function getDesktopWorkspace() {
  return desktopWorkspace;
}
