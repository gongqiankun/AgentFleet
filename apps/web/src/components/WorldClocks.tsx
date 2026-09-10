import { useEffect, useState } from "react";
import { t, useLocale } from "../i18n";
export const clockCities = [
  {id:"new-york",country:"us",label:"纽约·美东",zone:"America/New_York"},
  {id:"los-angeles",country:"us",label:"洛杉矶·美西",zone:"America/Los_Angeles"},
  {id:"toronto",country:"ca",label:"多伦多",zone:"America/Toronto"},
  {id:"london",country:"gb",label:"伦敦",zone:"Europe/London"},
  {id:"tokyo",country:"jp",label:"东京",zone:"Asia/Tokyo"},
  {id:"beijing",country:"cn",label:"北京",zone:"Asia/Shanghai"},
  {id:"berlin",country:"de",label:"柏林",zone:"Europe/Berlin"},
  {id:"paris",country:"fr",label:"巴黎",zone:"Europe/Paris"},
  {id:"sydney",country:"au",label:"悉尼",zone:"Australia/Sydney"},
];
export function cityTime(date: Date, zone: string) {
  return {time:new Intl.DateTimeFormat("en-GB",{timeZone:zone,hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(date),date:new Intl.DateTimeFormat("en-CA",{timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit"}).format(date)};
}
function weatherLabel(code:number) { return code===0?"晴":code<=3?"多云":[45,48].includes(code)?"雾":code>=95?"雷雨":[71,73,75,77,85,86].includes(code)?"雪":[56,57,66,67].includes(code)?"冻雨":code>=51?"雨":"天气"; }
type Forecast={date:string;min:number;max:number;code:number};
type Weather={updatedAt:string|null;cities:Record<string,Forecast[]>};
let cached:Weather={updatedAt:null,cities:{}}, expires=0, pending:Promise<Weather>|undefined;
async function getWeather() {
 if(Date.now()<expires)return cached;
 if(pending)return pending;
 pending=fetch('/api/world-weather',{credentials:'same-origin'}).then(async r=>{if(!r.ok)throw Error();const data=await r.json();if(!data.cities||typeof data.cities!=='object')throw Error();cached=data;expires=Date.now()+(data.updatedAt && Date.now()-Date.parse(data.updatedAt)<30*60_000 ? 30*60_000 : 60_000);return cached;}).catch(()=>{expires=Date.now()+60_000;return cached;});
 try{return await pending;}finally{pending=undefined;}
}
export function WorldClocks({side}:{side:"left"|"right"}) {
 useLocale();const [now,setNow]=useState(()=>new Date());const [weather,setWeather]=useState(cached);
 useEffect(()=>{
  if(typeof window.matchMedia!=='function')return;
  const media=window.matchMedia('(min-width: 901px)');let alive=true;
  const update=()=>{if(!media.matches||document.hidden)return;setNow(new Date());void getWeather().then(data=>{if(alive)setWeather(data);});};
  const timer=setInterval(update,15_000);media.addEventListener?.('change',update);document.addEventListener('visibilitychange',update);update();
  return()=>{alive=false;clearInterval(timer);media.removeEventListener?.('change',update);document.removeEventListener('visibilitychange',update);};
 },[]);
 return <div className={`world-clocks world-clocks--${side}`} aria-label={t("世界时间")}>
 {(side==='left'?clockCities.slice(0,4):clockCities.slice(4)).map(city=>{
  const local=cityTime(now,city.zone);const fresh=weather.updatedAt&&now.getTime()-Date.parse(weather.updatedAt)<2*60*60_000;
  const forecast=fresh?weather.cities[city.id]?.find(day=>day.date===local.date):undefined;
  return <div className="world-clock" key={city.id} title={`${t(city.label)} · ${local.date} · ${city.zone}`}>
   <span className="world-clock__city"><img src={`/flags/${city.country}.svg`} alt="" width="16" height="12"/><span>{t(city.label)}</span></span>
   <time dateTime={now.toISOString()}>{local.time}</time>
   <a className="world-clock__weather" href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer" title={`${t("当地今日天气")} · Open-Meteo${weather.updatedAt?' · '+weather.updatedAt:''}`}>{forecast?`${t(weatherLabel(forecast.code))} ${Math.round(forecast.min)}–${Math.round(forecast.max)}°C`:"—"}</a>
  </div>;
 })}</div>;
}
