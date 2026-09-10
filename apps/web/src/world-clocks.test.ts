import { expect, it } from 'vitest';
import { cityTime } from './components/WorldClocks';
it('uses 24-hour time, city dates and daylight saving',()=>{
 expect(cityTime(new Date('2026-07-01T04:00:00Z'),'America/New_York')).toEqual({time:'00:00',date:'2026-07-01'});
 expect(cityTime(new Date('2026-07-01T04:00:00Z'),'America/Los_Angeles')).toEqual({time:'21:00',date:'2026-06-30'});
 expect(cityTime(new Date('2026-01-01T05:00:00Z'),'America/New_York').time).toBe('00:00');
 expect(cityTime(new Date('2026-07-01T16:00:00Z'),'Asia/Shanghai')).toEqual({time:'00:00',date:'2026-07-02'});
 expect(cityTime(new Date('2026-07-01T12:00:00Z'),'Europe/London').time).toBe('13:00');
 expect(cityTime(new Date('2026-01-01T12:00:00Z'),'Europe/London').time).toBe('12:00');
 expect(cityTime(new Date('2026-07-01T12:00:00Z'),'Australia/Sydney').time).toBe('22:00');
 expect(cityTime(new Date('2026-01-01T12:00:00Z'),'Australia/Sydney').time).toBe('23:00');
});
