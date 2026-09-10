import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createWorldWeather} from '../src/world-weather.js';
test('fixed upstream with single-flight cache',async()=>{
 let calls=0;const service=createWorldWeather((async(url)=>{calls++;assert.equal(new URL(String(url)).hostname,'api.open-meteo.com');return Response.json(Array.from({length:7},()=>({daily:{time:['2026-09-10'],temperature_2m_min:[10],temperature_2m_max:[20],weather_code:[1]}})));}) as typeof fetch);
 const [a,b]=await Promise.all([service(),service()]);assert.equal(calls,1);assert.deepEqual(a,b);assert.equal(a.cities['tokyo']?.[0]?.max,20);await service();assert.equal(calls,1);
});
test('failure returns unavailable weather with retry throttling',async()=>{
 let calls=0;const service=createWorldWeather((async()=>{calls++;throw Error('offline');}) as typeof fetch);
 assert.deepEqual(await service(),{updatedAt:null,cities:{}});await service();assert.equal(calls,1);
});
