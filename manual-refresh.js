(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MonitorManualRefresh = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function bind({ button, status, controller, categoryKeys, formatTime = iso =>
    new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit',
      minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(iso)) }) {
    let active = null;
    function busy(value) {
      // Keep the native button focusable while repeated activations are ignored.
      button.setAttribute('aria-busy', String(value));
      button.setAttribute('aria-disabled', String(value));
      button.textContent = value ? '확인 중…' : '새로고침';
    }
    function message(text, state, outcome = 'pending') {
      const icon = outcome === 'success' ? ' ✅' : outcome === 'failure' ? ' ❌' : '';
      status.textContent = text + icon;
      status.dataset.state = state;
      status.dataset.outcome = outcome;
      status.setAttribute('aria-label', text + (outcome === 'success' ? ' · 새로고침 성공'
        : outcome === 'failure' ? ' · 새로고침 실패' : ''));
    }
    function report(snapshot) {
      const failed = categoryKeys.filter(key => !snapshot.statuses[key] || snapshot.statuses[key].error).length;
      const count = `${categoryKeys.length - failed}/${categoryKeys.length}`;
      const received = snapshot.lastFetchAt ? ` · ${formatTime(snapshot.lastFetchAt)} KST` : '';
      if (!snapshot.data) {
        message(`수신 실패 · 표시할 정상 기본 자료가 없습니다${received}`, 'error', 'failure');
        return;
      }
      if (failed || snapshot.baseError) {
        const result = failed ? `${failed === categoryKeys.length ? '파일' : '일부 파일'} 수신 실패 (${count})` : `공개 파일 ${count} 수신`;
        message(`${result}${snapshot.baseError ? ' · 기본 자료 수신 실패' : ''} · 마지막 정상 자료 유지${received}`,
          failed === categoryKeys.length ? 'error' : 'warning', 'failure');
        return;
      }
      const categories = snapshot.data.categories || [];
      const partial = categories.filter(c => c.checkStatus === 'partial').length;
      const errors = categories.filter(c => c.checkStatus === 'error').length;
      if (partial || errors) {
        message(`공개 파일 ${count} 수신${partial ? ` · 부분 확인 ${partial}개` : ''}${errors ? ` · 원문 점검 실패 ${errors}개` : ''}${received}`, 'warning', 'success');
      } else {
        message(`공개 파일 ${count} 수신 완료${received}`, 'success', 'success');
      }
    }
    function refresh() {
      if (active) return active;
      busy(true);
      message('공개 파일을 확인하고 있습니다.', 'loading');
      active = (async () => {
        // Assign active before a controller can throw synchronously.
        await Promise.resolve();
        try {
          // The shared controller coalesces this with an existing polling pass.
          const snapshot = await controller.refresh();
          report(snapshot);
          return snapshot;
        } catch (_) {
          message('새로고침 실패 · 마지막 정상 자료를 유지합니다.', 'error', 'failure');
          return null;
        } finally {
          busy(false);
          active = null;
        }
      })();
      return active;
    }
    button.addEventListener('click', refresh);
    return { refresh };
  }
  return { bind };
});
