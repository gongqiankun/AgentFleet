export function enrollmentTicket(enrollmentId: string, bootstrapSecret: string): string {
  if (!enrollmentId || !bootstrapSecret) throw new Error("Enrollment ticket is incomplete");
  return `${enrollmentId}.${bootstrapSecret}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export type InstallPlatform = "linux" | "macos" | "windows";

function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function onboardCommand(origin: string, ticket: string, platform: InstallPlatform = "linux"): string {
  const normalizedOrigin = new URL(origin).origin;
  if (platform === "windows") {
    return [
      "$i=Join-Path $env:TEMP 'agentfleet-install.ps1'",
      `Invoke-WebRequest ${powershellQuote(`${normalizedOrigin}/install.ps1`)} -OutFile $i`,
      `& $i -Mode Onboard -Url ${powershellQuote(normalizedOrigin)} -Ticket ${powershellQuote(ticket)} -Name $env:COMPUTERNAME`,
    ].join("; ");
  }
  const installer = platform === "macos" ? "install-macos" : "install";
  return [
    `curl -fsSL ${shellQuote(`${normalizedOrigin}/${installer}`)}`,
    "| sh -s --",
    `--url ${shellQuote(normalizedOrigin)}`,
    `--ticket ${shellQuote(ticket)}`,
    '--name "$(hostname)"',
  ].join(" ");
}
