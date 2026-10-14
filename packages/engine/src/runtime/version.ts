declare global {
  const PHINS_VERSION: string
  const PHINS_CHANNEL: string
}

export const InstallationVersion = typeof PHINS_VERSION === "string" ? PHINS_VERSION : "local"
export const InstallationChannel = typeof PHINS_CHANNEL === "string" ? PHINS_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
