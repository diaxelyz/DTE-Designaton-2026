// Plain-language helpers for the NeuroHalo app. No DOM here, so they can be tested in Node.

export const CHECKIN_REGIONS = ['Front', 'Back', 'Left', 'Right', 'Top', 'Face', 'Neck'];
export const CHECKIN_SYMPTOMS = ['Headache', 'Dizziness', 'Nausea', 'Blurry vision', 'Feeling foggy',
  'Ringing ears', 'Trouble balancing', 'Sensitive to light'];

// ---------- impacts ----------
export const impactLevel = e => (e.reporting_priority === 'high' ? 'hard' : 'moderate');
export const impactName = e => (impactLevel(e) === 'hard' ? 'Hard impact' : 'Moderate impact');
const clipped = e => (e.accel_clipped_axes || []).length > 0;

// Position on the strength meter (0..1) and the zone it falls in. No numbers shown to the athlete.
export function strength(e) {
  const g = e.recorded_peak_resultant_g ?? 0;
  if (clipped(e)) return {pos: 1, zone: 'hard', words: 'Off the scale'};
  const pos = Math.max(0.03, Math.min(1, (g - 1) / 15));      // 1 g (resting) .. 16 g
  const zone = g >= 12 ? 'hard' : g >= 8 ? 'moderate' : 'light';
  const words = {hard: 'Hard', moderate: 'Moderate', light: 'Light'}[zone];
  return {pos, zone, words};
}

export function peakSpin(samples = []) {
  let max = 0;
  for (const s of samples) {
    const v = Math.hypot(s.gx_dps ?? 0, s.gy_dps ?? 0, s.gz_dps ?? 0);
    if (v > max) max = v;
  }
  return max;
}

// Short plain sentences describing what happened
export function impactFacts(e) {
  const facts = [];
  const s = strength(e);
  facts.push(s.zone === 'hard' || s.words === 'Off the scale'
    ? (clipped(e) ? 'Very hard hit, stronger than the sensor can measure.' : 'A hard hit to the helmet.')
    : 'A moderate hit to the helmet.');
  if (e.samples?.length) {
    const spin = peakSpin(e.samples);
    if (spin >= 800) facts.push('Your head was turned very quickly.');
    else if (spin >= 300) facts.push('Your head was turned quickly.');
  }
  facts.push(e.crash_suspected
    ? 'Afterwards you were down and not moving, so the helmet started its crash countdown.'
    : 'Afterwards you kept moving.');
  return facts;
}

// ---------- time ----------
const sameDay = (a, b) => a.toDateString() === b.toDateString();
export function whenText(iso, now = new Date()) {
  if (!iso) return 'Time unknown';
  const d = new Date(iso), mins = Math.round((now - d) / 60000);
  if (mins >= 0 && mins < 1) return 'Just now';
  if (mins >= 0 && mins < 60) return `${mins} min ago`;
  const time = d.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
  if (sameDay(d, now)) return `Today, ${time}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return `Yesterday, ${time}`;
  return d.toLocaleDateString([], {weekday: 'short', month: 'short', day: 'numeric'}) + ', ' + time;
}

export function durationWords(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec} sec`;
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

export function timer(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function rideTitle(iso) {
  const d = new Date(iso), h = d.getHours();
  const part = h < 5 ? 'Night' : h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : h < 21 ? 'Evening' : 'Night';
  return `${d.toLocaleDateString([], {weekday: 'long'})} ${part.toLowerCase()} ride`;
}

export function countsText(hard, moderate) {
  if (!hard && !moderate) return 'No impacts';
  const parts = [];
  if (hard) parts.push(`${hard} hard`);
  if (moderate) parts.push(`${moderate} moderate`);
  return parts.join(', ') + (hard + moderate === 1 ? ' impact' : ' impacts');
}

export function checkinText(c) {
  if (!c) return 'Check-in needed';
  if (c.feel_fine) return 'Felt fine';
  const bits = [];
  if (c.pain_regions?.length) bits.push('Pain: ' + c.pain_regions.join(', ').toLowerCase());
  if (c.symptoms?.length) bits.push(c.symptoms.join(', ').toLowerCase());
  return bits.join(' · ') || 'Checked in';
}

// ---------- helmet ----------
export function positionText(tilt) {
  if (tilt == null) return '—';
  if (tilt < 30) return 'Upright';
  if (tilt < 60) return 'Tilted';
  if (tilt < 120) return 'On its side';
  return 'Upside down';
}

// ---------- weather (Open-Meteo, Fahrenheit / mph / inches) ----------
export function weatherKind(code) {
  if (code === 0) return 'sun';
  if (code <= 2) return 'partly';
  if (code === 3) return 'cloud';
  if (code <= 48) return 'fog';
  if (code <= 67 || (code >= 80 && code <= 82)) return 'rain';
  if (code <= 77 || code === 85 || code === 86) return 'snow';
  return 'storm';
}

export function weatherWords(code) {
  return {sun: 'Clear', partly: 'Partly cloudy', cloud: 'Cloudy', fog: 'Foggy', rain: 'Rain',
    snow: 'Snow', storm: 'Thunderstorms'}[weatherKind(code)];
}

// Verdict for riding in the next few hours. level: good | caution | bad
export function rideVerdict(current, hours = []) {
  const soon = hours.slice(0, 4);
  const storm = [current, ...soon].some(h => h && weatherKind(h.weather_code) === 'storm');
  const rainHour = soon.find(h => (h.precipitation_probability ?? 0) >= 50 || weatherKind(h.weather_code) === 'rain');
  const temp = current.temperature_2m, wind = Math.max(current.wind_speed_10m ?? 0, ...soon.map(h => h.wind_speed_10m ?? 0));
  const at = h => new Date(h.time * 1000).toLocaleTimeString([], {hour: 'numeric'});
  if (storm) return {level: 'bad', title: 'Not a good time to ride', detail: 'Thunderstorms around. Wait it out.'};
  if (weatherKind(current.weather_code) === 'snow' || temp <= 32)
    return {level: 'bad', title: 'Not ideal for riding', detail: 'Freezing conditions. Roads may be icy.'};
  if (weatherKind(current.weather_code) === 'rain' || (current.precipitation ?? 0) > 0)
    return {level: 'bad', title: 'Not ideal for riding', detail: 'It is raining right now. Roads are slippery.'};
  if (rainHour) return {level: 'caution', title: 'Ride soon, or wait', detail: `Rain likely around ${at(rainHour)}.`};
  if (wind >= 20) return {level: 'caution', title: 'Ride with care', detail: `Strong wind, up to ${Math.round(wind)} mph.`};
  if (temp >= 95) return {level: 'caution', title: 'Ride with care', detail: 'Very hot. Bring extra water.'};
  if (temp <= 40) return {level: 'caution', title: 'Ride with care', detail: 'Cold out. Dress warm.'};
  return {level: 'good', title: 'Great conditions to ride', detail: 'No rain expected and light wind.'};
}

// ---------- tip of the day (brain health for riders) ----------
export const TIPS = [
  {title: 'Fit it right', text: 'A helmet should sit level, about two finger-widths above your eyebrows. The side straps make a "V" just under each ear, and the chin strap is snug with room for about one finger.'},
  {title: 'One crash, new helmet', text: "Replace your helmet after any crash where it hit something, even if it looks fine. The foam inside crushes to absorb the hit and doesn't bounce back."},
  {title: 'When in doubt, sit it out', text: "If you hit your head and feel off, stop riding for the day. Riding again too soon after a possible concussion raises the chance of a second, worse injury."},
  {title: 'Symptoms can show up later', text: 'Concussion signs like headache, fogginess or trouble sleeping can appear hours or even a day after a hit. Check in with yourself the next morning too.'},
  {title: "Helmets don't stop every concussion", text: 'A helmet greatly lowers the risk of a serious head injury, but no helmet can fully prevent a concussion. How you feel after a hit matters more than how the helmet looks.'},
  {title: 'Know the red flags', text: 'A headache that gets worse, repeated vomiting, confusion, slurred speech, weakness or numbness, or passing out after a hit means emergency care, right away.'},
  {title: "Don't ride home alone after a hard hit", text: 'After a hard impact, have someone with you and let them watch for changes in how you act or talk for the next several hours.'},
  {title: 'Rest, then ease back', text: 'After a concussion, a short period of rest followed by a slow, step-by-step return to activity is the usual advice. Your doctor or athletic trainer sets the pace.'},
  {title: 'Twisting hits count too', text: 'Many brain injuries come from the head rotating quickly, not just from a straight hit. Some helmets add a layer designed to reduce rotation; look for it when you buy.'},
  {title: 'Check the sticker', text: 'Use a helmet certified for cycling. In the US, look for the CPSC sticker inside. Other countries have their own safety standards.'},
  {title: 'Tired brain, slower reactions', text: 'Poor sleep slows your reaction time and judgement on the bike. A well-rested brain spots hazards sooner.'},
  {title: 'Drink before you feel thirsty', text: 'Even mild dehydration can make it harder to concentrate. Sip water during longer or hotter rides.'},
  {title: 'Heat affects your head', text: 'Riding in strong heat can cause headache, dizziness and confusion. Slow down, find shade and cool off if you notice them.'},
  {title: 'Be seen', text: 'Front and rear lights and bright clothing help drivers notice you sooner, day and night. The best head injury is the one that never happens.'},
  {title: 'Keep your ears open', text: 'Hearing traffic around you helps you react in time. If you use headphones, keep the volume low or leave one ear free.'},
  {title: 'Helmets wear out', text: 'Sun, sweat and age slowly break down the materials. Check your helmet for cracks or loose parts and follow the maker\'s advice on when to replace it.'},
  {title: 'Hits add up', text: 'Several smaller hits in a short time are worth paying attention to. NeuroHalo\'s history helps you and your coach see the pattern.'},
  {title: 'Tell someone', text: 'After any hard hit, tell a coach, parent, teammate or friend, even if you feel okay. Others often notice changes before you do.'},
  {title: 'Screens after a hit', text: 'If you have concussion symptoms, many doctors suggest cutting back on screens and bright light for a while to let your brain recover.'},
  {title: 'Skip alcohol after a head injury', text: "Alcohol can hide warning signs and slow recovery after a hit to the head. Avoid it until you've been checked."},
  {title: 'Ride your skill level', text: 'Most crashes happen when speed or terrain gets ahead of skill. Practise new trails or tricks slowly before going fast.'},
];
export function tipOfDay(date = new Date(), offset = 0) {
  const day = Math.floor((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())) / 86400000);
  const i = ((day + offset) % TIPS.length + TIPS.length) % TIPS.length;
  return {...TIPS[i], index: i};
}
