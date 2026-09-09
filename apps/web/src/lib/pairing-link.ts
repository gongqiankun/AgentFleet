const PAIRING_PATH = "/pair";
const USER_CODE_PATTERN = /^([2-9A-HJ-NP-Z]{4})-?([2-9A-HJ-NP-Z]{4})$/i;

export interface PairingLinkIntent {
  hadCodeParameter: boolean;
  code?: string;
}

export function readPairingLink(pathname: string, search: string): PairingLinkIntent {
  const parameters = new URLSearchParams(search);
  const values = parameters.getAll("code");
  const normalizedPath = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (normalizedPath !== PAIRING_PATH || values.length !== 1) {
    return { hadCodeParameter: values.length > 0 };
  }

  const match = USER_CODE_PATTERN.exec(values[0]?.trim() ?? "");
  if (!match?.[1] || !match[2]) return { hadCodeParameter: true };
  return {
    hadCodeParameter: true,
    code: `${match[1].toUpperCase()}-${match[2].toUpperCase()}`,
  };
}

export function removePairingCode(href: string): string {
  const url = new URL(href);
  url.searchParams.delete("code");
  return `${url.pathname}${url.search}${url.hash}`;
}
