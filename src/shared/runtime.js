let secretBox = null;
let dummyPasswordHash = '';

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
