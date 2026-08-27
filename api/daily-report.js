// 매일 아침 어제 하루 트래픽을 메일로 보내는 크론 함수입니다.
// vercel.json 의 crons 가 매일 UTC 0시(한국 오전 9시경)에 이 함수를 부릅니다.
//
// 필요한 환경변수 (Vercel 프로젝트 Settings → Environment Variables):
//   ANALYTICS_TOKEN      Vercel 액세스 토큰 (Account Settings → Tokens)
//   ANALYTICS_PROJECT_ID 이 프로젝트의 Project ID (Settings → General)
//   RESEND_API_KEY       Resend API 키 (resend.com)
//   REPORT_TO            받을 메일 주소
//   ANALYTICS_TEAM_ID    (팀 소유 프로젝트일 때만) Team ID
//   CRON_SECRET          (선택) 설정하면 크론 외 호출을 막습니다

const API = 'https://api.vercel.com/v1/query/web-analytics';

module.exports = async (req, res) => {
  // 크론 인증 — CRON_SECRET 이 있으면 Vercel 크론이 보내는 헤더와 맞을 때만 실행
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['authorization'] !== 'Bearer ' + secret) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const token     = process.env.ANALYTICS_TOKEN;
  const projectId = process.env.ANALYTICS_PROJECT_ID;
  const teamId    = process.env.ANALYTICS_TEAM_ID;   // 개인 계정이면 비워 둡니다
  const resendKey = process.env.RESEND_API_KEY;
  const to        = process.env.REPORT_TO;

  const missing = [
    !token && 'ANALYTICS_TOKEN',
    !projectId && 'ANALYTICS_PROJECT_ID',
    !resendKey && 'RESEND_API_KEY',
    !to && 'REPORT_TO'
  ].filter(Boolean);
  if (missing.length) {
    return res.status(500).json({ error: '환경변수가 없습니다: ' + missing.join(', ') });
  }

  // 어제 (UTC 기준 하루 = 한국시간 어제 오전 9시 ~ 오늘 오전 9시)
  const now = new Date();
  const yesterday = new Date(now.getTime() - 864e5).toISOString().slice(0, 10);

  async function query(params) {
    const qs = new URLSearchParams(Object.assign({ projectId }, teamId ? { teamId } : {}, params));
    const r = await fetch(API + '/visits/aggregate?' + qs, {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (!r.ok) throw new Error('analytics ' + r.status + ': ' + (await r.text()).slice(0, 300));
    return (await r.json()).data || [];
  }

  function fmt(n) { return Number(n || 0).toLocaleString('ko-KR'); }

  // 그룹 행들을 HTML 표로 만듭니다. key 는 그룹 이름이 담긴 필드입니다.
  function table(title, rows, key) {
    if (!rows.length) return '';
    const tr = rows.map(function (r) {
      return '<tr><td style="padding:4px 12px 4px 0">' + (r[key] || '-') + '</td>' +
             '<td align="right" style="padding:4px 0">' + fmt(r.pageviews) + '</td>' +
             '<td align="right" style="padding:4px 0 4px 16px">' + fmt(r.visitors) + '</td></tr>';
    }).join('');
    return '<h3 style="margin:18px 0 6px">' + title + '</h3>' +
           '<table style="border-collapse:collapse;font-size:14px">' +
           '<tr><td style="color:#888;padding-right:12px"></td>' +
           '<td align="right" style="color:#888">조회</td>' +
           '<td align="right" style="color:#888;padding-left:16px">방문자</td></tr>' + tr + '</table>';
  }

  try {
    const range = { since: yesterday, until: yesterday };
    const results = await Promise.all([
      query(Object.assign({ by: 'day' }, range)),
      query(Object.assign({ by: 'route', limit: '10' }, range)),
      query(Object.assign({ by: 'country', limit: '5' }, range)),
      query(Object.assign({ by: 'deviceType', limit: '5' }, range))
    ]);
    const day = results[0][0] || { pageviews: 0, visitors: 0 };

    const subject = '[플래닛 도우미] ' + yesterday + ' 트래픽 — 방문자 ' +
                    fmt(day.visitors) + ' · 조회 ' + fmt(day.pageviews);

    const html =
      '<div style="font-family:sans-serif;max-width:520px">' +
      '<h2 style="margin:0 0 4px">플래닛 도우미 일일 리포트</h2>' +
      '<p style="margin:0 0 14px;color:#888">' + yesterday +
      ' (한국시간 어제 오전 9시 ~ 오늘 오전 9시)</p>' +
      '<p style="font-size:17px;margin:0">방문자 <b>' + fmt(day.visitors) +
      '명</b> · 페이지 조회 <b>' + fmt(day.pageviews) + '회</b></p>' +
      table('페이지별', results[1], 'route') +
      table('국가별', results[2], 'country') +
      table('기기별', results[3], 'deviceType') +
      '<p style="margin-top:20px;color:#aaa;font-size:12px">Vercel Web Analytics · 자동 발송</p>' +
      '</div>';

    const mail = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + resendKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: '플래닛 도우미 <onboarding@resend.dev>',
        to: [to],
        subject: subject,
        html: html
      })
    });
    if (!mail.ok) throw new Error('resend ' + mail.status + ': ' + (await mail.text()).slice(0, 300));

    return res.status(200).json({
      ok: true,
      date: yesterday,
      visitors: day.visitors,
      pageviews: day.pageviews,
      sentTo: to
    });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
