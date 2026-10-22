/**
 * Saves a blob as a file, through a temporary link. The link's address is freed a moment later, not straight away:
 * freeing it during the click can cancel the download in some browsers (Firefox and Safari).
 */
export function saveBlob(blob: Blob, filename: string) {
  const href = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href, download: filename }).click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

/** Saves text as a file. */
export function saveText(text: string, filename: string, type = 'text/plain') {
  saveBlob(new Blob([text], { type }), filename);
}
