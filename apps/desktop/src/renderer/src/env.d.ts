/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Development shortcut: sign in without showing the login screen. */
  readonly VITE_DEV_AUTO_LOGIN?: string;
  /** Account the fixed development verification code is issued for. */
  readonly VITE_DEV_AUTO_LOGIN_EMAIL?: string;
  /** Verification code accepted by a non-production server. */
  readonly VITE_DEV_AUTO_LOGIN_CODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
