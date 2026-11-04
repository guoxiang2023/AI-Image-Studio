function canDownloadUpdate(result) {
  return Boolean(result?.isUpdateAvailable && result.updateInfo?.version);
}

module.exports = { canDownloadUpdate };
