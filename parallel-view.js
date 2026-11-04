(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const COLORS = ['#75adff', '#ff936b', '#52d6ae', '#f3c252', '#ed87be'];
  const TYPES = { prediction:'예측', media_call:'언론 당선 판단', official_certification:'공식 인증', statement:'발언', concession:'승복' };
  const AVAILABILITY = { unsupported:'미지원·공급 미확인', delayed:'지연 자료', available:'자료 공급 확인' };
  const MARKET = { unknown:'거래시간 미확인', open:'거래 중', closed:'휴장·마감' };
  const time = iso => iso ? new Intl.DateTimeFormat('ko-KR', {timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(iso)) : '미확인';
  const fullTime = iso => iso ? new Intl.DateTimeFormat('ko-KR', {timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(iso)) : '미확인';
  const percent = value => `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
  const sources = urls => urls.length ? urls.map((url, i) => `<a class="source" href="${esc(url)}" target="_blank" rel="noopener noreferrer">출처 ${i + 1} · ${esc(new URL(url).hostname)}</a>`).join('') : '확인된 원출처 없음';
  let published = null;
  let localReference = null;
  let pollTimer;
  let manualBusy = false;

  function combinedEvents(data) {
    const events = [...data.events];
    if (localReference && published) {
      for (const event of published.events) if (!events.some(item => item.id === event.id)) events.push(event);
    }
    return events.sort((a,b) => Date.parse(a.at) - Date.parse(b.at));
  }

  function chart(data, allEvents) {
    const W = 1360, LEFT = 80, RIGHT = 1090, TOP = 112, LANE = 290;
    const HEIGHT = TOP + 4 * LANE + 45;
    const start = Date.parse(data.window.start), end = Date.parse(data.window.end);
    const x = at => LEFT + (Date.parse(at) - start) / (end - start) * (RIGHT - LEFT);
    const events = allEvents.filter(e => e.verification === 'verified' && Date.parse(e.at) >= start && Date.parse(e.at) <= end);
    const ticks = [];
    for (let tick = start; tick <= end; tick += 60 * 60 * 1000) ticks.push(new Date(tick).toISOString());
    let svg = `<svg viewBox="0 0 ${W} ${HEIGHT}" role="img" aria-labelledby="plot-title plot-desc"><title id="plot-title">${esc(data.title)}</title><desc id="plot-desc">네 패널은 동일한 KST 시간축을 사용합니다. 긴 공백은 선으로 잇지 않습니다. 마지막 값 옆에 계열별 시각을 표시합니다. 원출처로 확인한 사건만 수직 점선으로 표시합니다.</desc>`;
    svg += `<text x="${LEFT}" y="20" fill="#a9b2c0" font-size="12">${time(data.window.start)}–${time(data.window.end)} KST · ${localReference ? '역사적 참조 / 수치 미검증' : '검증된 공개 자료만 표시'}</text>`;
    // Every event uses the very same timestamp-to-x transformation as all series.
    events.forEach((e, i) => {
      const xx = x(e.at);
      svg += `<line x1="${xx}" x2="${xx}" y1="92" y2="${TOP + 4 * LANE - 22}" stroke="#91a4bf" stroke-dasharray="4 5" opacity=".6"/><text x="${xx}" y="${44 + (i % 2) * 21}" text-anchor="middle" fill="#c0cee0" font-size="11">${esc(time(e.at) + ' ' + e.label)}<title>${esc(TYPES[e.type] + ' · 공식 인증과 구분 · ' + e.sourceUrl)}</title></text>`;
    });
    ParallelData.PANELS.forEach((panel, panelIndex) => {
      const top = TOP + panelIndex * LANE, plotTop = top + 58, plotBottom = top + 235;
      const items = data.series.filter(s => s.panel === panel.key);
      const values = items.flatMap(s => s.points.map(p => p.pct));
      let low = Math.min(0, ...values), high = Math.max(0, ...values);
      const padding = Math.max(.3, (high-low) * .13);
      low -= padding; high += padding;
      const y = value => plotBottom - (value-low)/(high-low)*(plotBottom-plotTop);
      svg += `<text x="${LEFT}" y="${top}" fill="#f2f4f7" font-size="18" font-weight="600">${esc(panel.label)}</text>`;
      items.forEach((series, i) => {
        const lx = LEFT + i * 193;
        svg += `<line x1="${lx}" x2="${lx+17}" y1="${top+26}" y2="${top+26}" stroke="${COLORS[i%COLORS.length]}" stroke-width="3"/><text x="${lx+23}" y="${top+30}" fill="#b4bdca" font-size="11">${esc(series.label)}<title>${esc(series.basis)}</title></text>`;
      });
      ticks.forEach(t => {const xx=x(t);svg += `<line x1="${xx}" x2="${xx}" y1="${plotTop}" y2="${plotBottom}" stroke="#2b3543" opacity=".5"/><text x="${xx}" y="${plotBottom+23}" text-anchor="middle" fill="#a9b2c0" font-size="11">${time(t)}</text>`;});
      for(let i=0;i<5;i++) {
        const value = low + (high-low) * i/4, yy = y(value);
        svg += `<line x1="${LEFT}" x2="${RIGHT}" y1="${yy}" y2="${yy}" stroke="#2b3543"/><text x="${LEFT-10}" y="${yy+4}" text-anchor="end" fill="#a9b2c0" font-size="11">${percent(value)}</text>`;
      }
      svg += `<line x1="${LEFT}" x2="${RIGHT}" y1="${y(0)}" y2="${y(0)}" stroke="#738298" opacity=".8"/>`;
      if (!values.length) svg += `<text x="${(LEFT+RIGHT)/2}" y="${(plotTop+plotBottom)/2}" text-anchor="middle" fill="#a9b2c0" font-size="14">시계열 미연결 · 확인되지 않은 수치는 표시하지 않습니다</text>`;
      const labels = [];
      items.forEach((series, i) => {
        const color = COLORS[i%COLORS.length];
        for(const segment of ParallelData.segments(series.points, data.window.intervalMinutes)) {
          if(segment.length > 1) svg += `<polyline points="${segment.map(p=>`${x(p.at)},${y(p.pct)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="2.4"/>`;
          for (const point of segment) svg += `<circle class="plot-dot" cx="${x(point.at)}" cy="${y(point.pct)}" r="2.3" fill="${color}"><title>${esc(series.label + ' · ' + time(point.at) + ' KST · ' + percent(point.pct) + ' · ' + series.basis + (localReference?' · 미검증 역사적 참조':''))}</title></circle>`;
        }
        const last = series.points.at(-1);
        if (last) labels.push({series,last,color,actualY:y(last.pct),labelY:y(last.pct)});
      });
      labels.sort((a,b)=>a.actualY-b.actualY);
      labels.forEach((label,i)=>label.labelY=Math.max(plotTop+5,label.actualY,i?labels[i-1].labelY+30:plotTop+5));
      if(labels.length && labels.at(-1).labelY>plotBottom) {
        labels.at(-1).labelY=plotBottom;
        for(let i=labels.length-2;i>=0;i--)labels[i].labelY=Math.min(labels[i].labelY,labels[i+1].labelY-30);
      }
      for(const label of labels) svg += `<path d="M ${x(label.last.at)} ${label.actualY} L ${RIGHT+10} ${label.labelY} L ${RIGHT+17} ${label.labelY}" fill="none" stroke="#7c8799" stroke-dasharray="2 4" stroke-width="1" opacity=".6"/><text x="${RIGHT+23}" y="${label.labelY}" fill="${label.color}" font-size="12">${esc(label.series.label + ' ' + percent(label.last.pct))}</text><text x="${RIGHT+23}" y="${label.labelY+13}" fill="#a9b2c0" font-size="10">${time(label.last.at)} KST${localReference?' · 미검증':''}</text>`;
    });
    svg += `<text x="${LEFT}" y="${HEIGHT-5}" fill="#a9b2c0" font-size="11">공통 시간축 / KST · 패널별 세로축 범위와 계열별 비교 기준은 다릅니다.</text></svg>`;
    return {svg, count:events.length};
  }

  function render() {
    const data = localReference || published;
    if(!data)return;
    const allEvents = combinedEvents(data);
    const result = chart(data, allEvents);
    const numeric = data.series.filter(s=>s.points.length).length;
    $('chart').innerHTML=result.svg;
    $('coverage-title').textContent = localReference ? '역사적 참조 · 독립 검증되지 않은 수치' : numeric ? '확인된 자료만 표시' : '시계열 공급 확인 중 · 자동 수집 미연결';
    $('coverage-text').textContent = localReference ? '로컬 CSV의 등락률만 재현합니다. 원가격·수집 시각·거래시간·재배포 권한은 미확인입니다. 긴 공백은 잇지 않으며, 대만 마감 설명과 13:45 관측의 충돌도 해소되지 않았습니다.' : `${numeric}/${data.series.length}개 계열의 시계열이 연결되어 있습니다. 실제 공급과 이용 조건이 확인되지 않은 계열은 미지원으로 표시합니다. 게시 파일 확인 주기는 시세 갱신 보장이 아닙니다.`;
    $('dataset-mode').textContent = localReference ? '로컬 역사적 참조 / 공개 자료에 합치지 않음' : '공개 자료 / 시계열 원자료 검증 필요';
    $('chart-period').textContent = `${new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',year:'numeric',month:'long',day:'numeric'}).format(new Date(data.window.start))} · ${time(data.window.start)}–${time(data.window.end)} KST · ${data.window.intervalMinutes}분 기준 격자 · 실제 시각 별도`;
    $('event-note').textContent = `원출처 확인 사건선 ${result.count}개 · 미검증 사건은 아래 목록에만 표시합니다. CSV 사건과 DDHQ 사건은 서로 다른 출처의 기록입니다.`;
    $('series-table').innerHTML = data.series.map(s=>{
      const stats=ParallelData.summarizeSeries(s,data.window),last=s.points.at(-1);
      const delay=s.delaySeconds===null?'지연 미확인':`${s.delaySeconds}초 지연`;
      const sourceClock=localReference?`참조 CSV 표기 ${fullTime(s.asOf)}<small>실제 원자료 시각 미확인</small>`:`원자료 ${fullTime(s.asOf)}`;
      return `<tr><td><strong>${esc(s.label)}</strong><small>${esc(s.basis)}</small><small>${esc(s.instrument)}</small></td><td>${esc(AVAILABILITY[s.availability])}<small>${esc(s.provider)} · ${esc(MARKET[s.marketState])}</small>${s.sourceUrl?sources([s.sourceUrl]):''}</td><td class="mono">${last?percent(last.pct):'자료 없음'}<small>${last?time(last.at)+' KST':'—'}${s.verification==='unverified'?' · 미검증':''}</small></td><td>${sourceClock}<small>확인 ${fullTime(s.observedAt)}</small><small>${delay}</small></td><td>${last?`내부 격자 누락 ${stats.missingGridCount} · 비정규 시각 ${stats.offGridCount}`:'공백 계산 불가 · 자료 없음'}<small>${s.redistribution==='permitted'?'공개 이용 조건 확인':'재배포 권한 미확인'} · ${stats.pointCount}개 관측</small><small>첫·끝 관측 밖은 휴장으로 추정하지 않음</small></td></tr>`;
    }).join('');
    $('events').innerHTML = allEvents.length ? allEvents.map(e=>`<li><time datetime="${esc(e.at)}">${time(e.at)} KST</time><div><span class="tag${e.verification==='verified'?'':' unverified'}">${esc(TYPES[e.type])}</span><strong>${esc(e.label)}</strong><p class="hint">${e.verification==='verified'?'원출처 시각 확인 · 확인 '+fullTime(e.observedAt):'역사적 CSV 참조 · 실제 사건 시각 미검증 · 사건선 제외'}${e.type==='media_call'?' · 공식 인증 아님':''}</p>${e.sourceUrl?sources([e.sourceUrl]):''}</div></li>`).join('') : '<li><p class="empty">원출처로 시각을 확인한 사건이 없습니다.</p></li>';
    const stories = localReference ? [] : data.stories;
    $('stories').innerHTML = stories.length ? stories.map(story=>`<article class="story"><h3>${time(story.at)} KST · ${esc(story.title)}</h3><dl><dt>이야기</dt><dd>${esc(story.story)}</dd><dt>출처</dt><dd>${sources(story.sources)}</dd><dt>해석</dt><dd>${esc(story.interpretation)}</dd><dt>판정</dt><dd>${esc(story.verdict)}</dd><dt>다음 관찰점</dt><dd>${esc(story.nextWatch)}</dd></dl></article>`).join('') : '<p class="empty">검증된 시장 해설이 아직 없습니다. 선거 사건과 시세의 인과를 추정해 이야기를 만들지 않습니다.</p>';
    $('clear-reference').hidden=!localReference;
  }

  const controller = ParallelRefresh.createController({onChange(snapshot){
    published=snapshot.data;
    $('fetch-status').dataset.error=String(Boolean(snapshot.error));
    $('fetch-status').textContent = snapshot.error ? `${snapshot.error}${snapshot.data?' · 마지막 정상 게시자료 유지':''} · 확인 시도 ${fullTime(snapshot.lastAttemptAt)} KST` : `게시자료 수신 ${fullTime(snapshot.lastReceivedAt)} KST · 파일 작성 ${fullTime(snapshot.data?.publishedAt)} KST · 시세 원자료 시각은 아래 계열별 표에서 확인`;
    render();
  }});
  async function refresh() {
    if(manualBusy)return;
    manualBusy=true;
    $('refresh').setAttribute('aria-busy','true');
    $('refresh').setAttribute('aria-disabled','true');
    try{await controller.refresh();}finally{manualBusy=false;$('refresh').setAttribute('aria-busy','false');$('refresh').setAttribute('aria-disabled','false');}
  }
  function schedule(){clearInterval(pollTimer);pollTimer=setInterval(()=>{if(!document.hidden)refresh();},Number($('poll-minutes').value)*60000);}
  $('refresh').addEventListener('click',refresh);
  $('poll-minutes').addEventListener('change',schedule);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
  $('reference-form').addEventListener('submit',async event=>{
    event.preventDefault();
    const prices=$('prices-file').files[0],events=$('events-file').files[0];
    try{
      if(!prices||!events||prices.size>1024*1024||events.size>1024*1024)throw new Error('invalid file');
      const values=await Promise.all([prices.text(),events.text()]);
      const candidate=ParallelData.parseReference(...values);
      localReference=ParallelData.validateDataset(candidate,{allowLocalReference:true});
      $('import-status').textContent=`로컬 참조 ${localReference.series.length}개 계열·${localReference.events.length}개 사건을 불러왔습니다. 파일을 전송하지 않았습니다.`;
      render();
    }catch(_){$('import-status').textContent='CSV 형식·시각·숫자를 확인할 수 없습니다. 이전 화면을 유지합니다.';}
  });
  $('clear-reference').addEventListener('click',()=>{localReference=null;$('reference-form').reset();$('import-status').textContent='로컬 참조를 닫았습니다.';render();});
  // Explicit local-preview mode only. This file is ignored by Git and never a public source.
  async function previewReference(){
    if(new URLSearchParams(location.search).get('reference')!=='local')return;
    try{
      const response=await fetch('data/parallel-reference.local.json',{credentials:'omit',cache:'no-store'});
      if(!response.ok)throw new Error('not found');
      localReference=ParallelData.validateDataset(await response.json(),{allowLocalReference:true});
      $('import-status').textContent='로컬 미리보기용 역사적 참조입니다. 이 파일은 Git 게시 대상에서 제외됩니다.';
      render();
    }catch(_){$('import-status').textContent='로컬 참조 파일이 없습니다. CSV 두 개를 선택해 열 수 있습니다.';}
  }
  schedule();refresh();previewReference();
})();
