const locations = [
  ["new-york",40.7128,-74.006], ["los-angeles",34.0522,-118.2437], ["toronto",43.6532,-79.3832],
  ["tokyo",35.6762,139.6503], ["beijing",39.9042,116.4074], ["berlin",52.52,13.405], ["paris",48.8566,2.3522],
  ["london",51.5074,-0.1278], ["sydney",-33.8688,151.2093],
] as const;
type Forecast = { date: string; min: number; max: number; code: number };
export type WorldWeather = { updatedAt: string | null; cities: Record<string, Forecast[]> };
export function createWorldWeather(fetcher: typeof fetch = fetch) {
  let cache: WorldWeather = {updatedAt:null,cities:{}};
  let retryAt = 0;
  let pending: Promise<WorldWeather> | undefined;
  return async (): Promise<WorldWeather> => {
    if (Date.now() < retryAt) return cache;
    if (pending) return pending;
    pending = (async () => {
      try {
        const url = new URL("https://api.open-meteo.com/v1/forecast");
        url.search = new URLSearchParams({latitude:locations.map(x=>x[1]).join(","),longitude:locations.map(x=>x[2]).join(","),daily:"weather_code,temperature_2m_max,temperature_2m_min",timezone:"auto",forecast_days:"2"}).toString();
        const response = await fetcher(url, {signal:AbortSignal.timeout(8000)});
        if (!response.ok) throw new Error("Weather unavailable");
        const rows = await response.json() as {daily?:{time?:string[];temperature_2m_min?:number[];temperature_2m_max?:number[];weather_code?:number[]}}[];
        if (!Array.isArray(rows) || rows.length !== locations.length) throw new Error("Invalid forecast");
        const cities: WorldWeather["cities"] = {};
        rows.forEach((row,i)=>{const d=row.daily; cities[locations[i]![0]]=(d?.time??[]).flatMap((date,j)=>{
          const min=d?.temperature_2m_min?.[j],max=d?.temperature_2m_max?.[j],code=d?.weather_code?.[j];
          return /^\d{4}-\d{2}-\d{2}$/.test(date)&&typeof min==="number"&&Number.isFinite(min)&&typeof max==="number"&&Number.isFinite(max)&&typeof code==="number"&&Number.isFinite(code)?[{date,min,max,code}]:[];
        });});
        cache={updatedAt:new Date().toISOString(),cities};retryAt=Date.now()+30*60_000;
      } catch { retryAt=Date.now()+60_000; }
      return cache;
    })();
    try { return await pending; } finally { pending=undefined; }
  };
}
