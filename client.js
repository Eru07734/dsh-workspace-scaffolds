window.__ModuleLoader__.load({
  id: 'dsh-workspace-scaffolds',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'workspaceScaffolds';
    const API = '/api/workspace-scaffolds';

    const zh = {
      title: '工程脚手架',
      intro:
        '把工程与脚手架插件关联起来：开工前准备、工作中追加、不用时休眠保留到磁盘、再次使用时恢复。脚手架包是原生 DSH 插件，在一个 DSH 环境内共享；休眠只在没有其他工程需要时才真正停用。',
      loading: '正在读取…',
      refresh: '刷新',
      revision: '配置版本',
      version: '版本',
      versionUnknown: '未知',
      stepPending: '等待',
      stepActive: '进行中',
      stepDone: '已完成',
      stepFailed: '失败',
      stepSkipped: '已跳过',
      status_running: '进行中',
      status_succeeded: '已完成',
      status_failed: '失败',
      profileSpec: 'profile 声明',
      restartPending: 'profile 请求的版本与内存中运行的构建不同，需要重启 DSH 才能生效。',
      capabilityMissing: '原生插件管理器不可用，只能查看已保存的关联。',
      workspaceMissing: '原生工程注册表不可用，请确认 DSH 版本。',
      runningAgents: '有任务正在执行；休眠会推迟到空闲时执行。',
      pendingSleeps: '排队等待空闲的休眠',
      recovery: '状态文件曾损坏，已从备份恢复。',
      degraded: '自动恢复曾失败，请在本页手动准备后重试。',
      sectionWorkspaces: '工程',
      sectionBindings: '已关联脚手架',
      sectionPackages: '本地仓库与已装插件',
      sectionRegister: '注册工程',
      registerHint: '把一个已存在的目录注册为工程，纳入本插件管理。注册本身不会启用任何脚手架，也不会写入文件。',
      registerPath: '工程目录',
      registerRun: '注册',      sectionImport: '导入脚手架包',
      sectionResult: '最近一次操作',
      noWorkspaces: '还没有关联记录。先在下方导入或选择脚手架包，再添加到工程。',
      selectWorkspace: '选择工程',
      unmanagedWorkspaces: '尚未纳入管理的工程',
      addTo: '添加到该工程',
      packageLabel: '脚手架包',
      selectPackage: '选择包',
      state: '期望状态',
      awake: '使用中',
      sleeping: '已休眠',
      autoRestore: '随工程自动恢复',
      ready: '已就绪',
      notReady: '未就绪',
      blockers: '待处理',
      columnPackage: '包',
      columnVersion: '版本',
      columnNative: '原生状态',
      columnArchive: '归档',
      columnHolders: '使用中的工程',
      columnActions: '操作',
      nativeMatch: '已安装',
      nativeAbsent: '未安装',
      nativeMismatch: '版本不符',
      nativeError: '原生报错',
      nativeEnabled: '已启用',
      nativeDisabled: '已停用',
      archiveYes: '有',
      archiveNo: '无',
      shared: '多工程共享',
      pinnedTag: '全局常驻',
      externalTag: '外部管理',
      actionWake: '恢复',
      actionSleep: '休眠并保留',
      actionUnbind: '解除关联',
      actionPreview: '生成预览',
      actionApply: '生成文件',
      actionPin: '设为全局常驻',
      actionUnpin: '取消全局常驻',
      actionDeleteArchive: '删除归档',
      importHint:
        '填写脚手架包目录或 .tgz 的绝对路径。导入会校验原生 dsh.bundle 声明、计算内容哈希、保存到本地归档，并在不启用的前提下安装。',
      importPath: '路径',
      importRun: '导入',
      importInstalled: '已安装但未启用',
      templateTitle: '生成预览',
      templateEmpty: '这个包没有提供模板。',
      templateCreatable: '将新建',
      templateIdentical: '内容相同，跳过',
      templateConflict: '冲突，已阻止',
      templateBlocked: '存在冲突，本次不会写入任何文件。请先处理这些路径。',
      variables: '模板变量',
      close: '关闭',
      confirmUnbind: '解除关联不会删除已生成的文件，但会释放该工程对这些脚手架的占用。确认继续？',
      confirmDelete: '删除本地归档后，若插件也被卸载，将无法离线恢复。确认删除？',
      resultOk: '操作已完成',
      resultCode: '失败原因',
      loadFailed: '读取面板状态失败',
      pendingIdle: '有任务在执行，休眠已排队，空闲后自动完成。',
      restartRequired: '原生插件管理器要求重启 DSH 后才会生效。',
      noPackages: '本地仓库为空。',
      path: '路径',
      missing: '工程目录当前不可用',
    };

    const en = {
      title: 'Workspace scaffolds',
      intro:
        'Tie a workspace to its scaffold plugin bundles: prepare before work, add during work, shelve to disk when idle, and restore when you come back. Scaffold bundles are native DSH plugins shared by the whole profile; a shelf only disables one when no other workspace still needs it.',
      loading: 'Loading…',
      refresh: 'Refresh',
      revision: 'Revision',
      version: 'Version',
      versionUnknown: 'unknown',
      stepPending: 'waiting',
      stepActive: 'running',
      stepDone: 'done',
      stepFailed: 'failed',
      stepSkipped: 'skipped',
      status_running: 'running',
      status_succeeded: 'done',
      status_failed: 'failed',
      profileSpec: 'profile declares',
      restartPending: 'The profile asks for a different build than the one running; restart DSH to apply it.',
      capabilityMissing: 'The native plugin manager is unavailable; saved associations are read-only.',
      workspaceMissing: 'The native workspace registry is unavailable. Check the DSH version.',
      runningAgents: 'Work is running; a shelf is deferred until the environment is idle.',
      pendingSleeps: 'Shelves waiting for idle',
      recovery: 'The state file was damaged and was restored from its backup.',
      degraded: 'An automatic restore failed. Prepare the workspace from this page and retry.',
      sectionWorkspaces: 'Workspaces',
      sectionBindings: 'Associated scaffolds',
      sectionPackages: 'Local warehouse and installed bundles',
      sectionRegister: 'Register a project',
      registerHint: 'Register an existing directory as a workspace under this plugin. Registering enables no scaffold and writes no files.',
      registerPath: 'Project directory',
      registerRun: 'Register',      sectionImport: 'Import a scaffold package',
      sectionResult: 'Last operation',
      noWorkspaces: 'No associations yet. Import or pick a scaffold package below, then add it to a workspace.',
      selectWorkspace: 'Workspace',
      unmanagedWorkspaces: 'Workspaces not managed yet',
      addTo: 'Add to this workspace',
      packageLabel: 'Scaffold package',
      selectPackage: 'Select a package',
      state: 'Requested state',
      awake: 'in use',
      sleeping: 'shelved',
      autoRestore: 'Restore with the workspace',
      ready: 'Ready',
      notReady: 'Not ready',
      blockers: 'Needs attention',
      columnPackage: 'Package',
      columnVersion: 'Version',
      columnNative: 'Native state',
      columnArchive: 'Archive',
      columnHolders: 'Workspaces using it',
      columnActions: 'Actions',
      nativeMatch: 'installed',
      nativeAbsent: 'absent',
      nativeMismatch: 'version mismatch',
      nativeError: 'native error',
      nativeEnabled: 'enabled',
      nativeDisabled: 'disabled',
      archiveYes: 'stored',
      archiveNo: 'none',
      shared: 'shared',
      pinnedTag: 'kept globally',
      externalTag: 'externally managed',
      actionWake: 'Restore',
      actionSleep: 'Shelve',
      actionUnbind: 'Remove association',
      actionPreview: 'Preview files',
      actionApply: 'Generate files',
      actionPin: 'Keep globally enabled',
      actionUnpin: 'Stop keeping it enabled',
      actionDeleteArchive: 'Delete snapshot',
      importHint:
        'Enter an absolute path to a scaffold package directory or .tgz. Import validates the native dsh.bundle declaration, hashes the content, stores a snapshot, and installs without enabling.',
      importPath: 'Path',
      importRun: 'Import',
      importInstalled: 'installed but not enabled',
      templateTitle: 'Generation preview',
      templateEmpty: 'This package declares no templates.',
      templateCreatable: 'to create',
      templateIdentical: 'identical, skipped',
      templateConflict: 'conflicting, blocked',
      templateBlocked: 'Conflicts found, so nothing will be written. Resolve these paths first.',
      variables: 'Template variables',
      close: 'Close',
      confirmUnbind: 'Removing the association never deletes generated files, but it releases this workspace\'s claim on these scaffolds. Continue?',
      confirmDelete: 'After deleting a local snapshot, a removed plugin can no longer be restored offline. Delete it?',
      resultOk: 'Operation completed',
      resultCode: 'Failure code',
      loadFailed: 'Could not read the panel state',
      pendingIdle: 'Work is running, so the shelf is queued and will complete when the environment goes idle.',
      restartRequired: 'The native plugin manager needs a DSH restart before this takes effect.',
      noPackages: 'The local warehouse is empty.',
      path: 'Path',
      missing: 'The workspace directory is currently unavailable',
    };

    const css = `
.wsc{display:flex;flex-direction:column;gap:20px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}
.wsc h3{margin:0 0 4px;font-size:15px}
.wsc section{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px}
.wsc .wsc-row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.wsc .wsc-hint{margin:6px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px}
.wsc .wsc-tag{display:inline-block;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:1px 8px;font-size:11px;color:var(--dsw-alias-label-secondary);margin-right:6px}
.wsc button{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;min-height:32px;padding:5px 12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}
.wsc button:disabled{opacity:.5;cursor:not-allowed}
.wsc input,.wsc select{box-sizing:border-box;min-height:32px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:5px 9px;font:inherit}
.wsc input[type=text]{width:100%}
.wsc table{width:100%;border-collapse:collapse}
.wsc th,.wsc td{text-align:left;padding:7px 8px;border-top:1px solid var(--dsw-alias-border-l2);vertical-align:top}
.wsc th{color:var(--dsw-alias-label-secondary);font-weight:500}
.wsc .wsc-error{color:var(--dsw-alias-state-error-primary);margin:6px 0 0}
.wsc .wsc-ok{color:var(--dsw-alias-label-secondary);margin:6px 0 0}
.wsc pre{margin:6px 0 0;padding:10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);overflow:auto;max-height:260px;font-size:12px}
.wsc .wsc-field{display:flex;flex-direction:column;gap:5px;margin:10px 0}
.wsc .wsc-files{margin:8px 0 0;padding-left:18px}
.wsc .wsc-create{color:var(--dsw-alias-state-business-primary)}
.wsc .wsc-identical{color:var(--dsw-alias-label-secondary)}
.wsc .wsc-conflict{color:var(--dsw-alias-state-error-primary)}
.wsc .wsc-progress{margin:10px 0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.wsc .wsc-progress-head{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;margin-bottom:6px}
.wsc .wsc-progress-head .wsc-progress-action{font-weight:500}
.wsc .wsc-progress-head .wsc-progress-phase{color:var(--dsw-alias-label-secondary);font-size:12px}
.wsc .wsc-progress-steps{list-style:none;margin:0;padding:0;font-size:12px}
.wsc .wsc-progress-steps li{display:flex;gap:8px;align-items:baseline;padding:2px 0}
.wsc .wsc-step-mark{width:14px;flex:0 0 14px;text-align:center;color:var(--dsw-alias-label-secondary)}
.wsc .wsc-step-detail{color:var(--dsw-alias-label-secondary);margin-left:auto;padding-left:10px;font-size:11px;text-align:right}
.wsc .wsc-step-active .wsc-step-mark{color:var(--dsw-alias-state-business-primary)}
.wsc .wsc-step-active .wsc-step-label{font-weight:500}
.wsc .wsc-step-done .wsc-step-mark{color:var(--dsw-alias-state-success-primary)}
.wsc .wsc-step-failed .wsc-step-mark,.wsc .wsc-step-failed .wsc-step-label{color:var(--dsw-alias-state-error-primary)}
.wsc .wsc-step-pending .wsc-step-label,.wsc .wsc-step-skipped .wsc-step-label{color:var(--dsw-alias-label-secondary)}
.wsc .wsc-progress-status-running{color:var(--dsw-alias-state-business-primary)}
.wsc .wsc-progress-status-succeeded{color:var(--dsw-alias-state-success-primary)}
.wsc .wsc-progress-status-failed{color:var(--dsw-alias-state-error-primary)}
`;

    /** @returns {string} */
    function operationId() {
      const cryptoObject = typeof crypto !== 'undefined' ? crypto : undefined;
      if (cryptoObject && typeof cryptoObject.randomUUID === 'function') return cryptoObject.randomUUID();
      return `op-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    /**
     * @param {string} path
     * @param {object} [body]
     * @returns {Promise<any>}
     */
    async function request(path, body) {
      const response = await fetch(`${API}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const payload = await response.json().catch(() => ({ ok: false, code: 'invalid-response', details: {} }));
      if (!payload.ok) {
        const error = new Error(payload.code);
        error.code = payload.code;
        error.details = payload.details ?? {};
        throw error;
      }
      return payload.value;
    }

    /** @param {object} t @returns {object} */
    function usePanel(t) {
      const [state, setState] = React.useState(null);
      // Two error channels, deliberately not one slot. `error` says why the
      // user's last action failed; `loadError` says why the snapshot could not
      // be read. Sharing one slot made the refresh that follows a failed action
      // erase its reason, so a blocked template-apply looked like nothing
      // happened. Keeping them apart means a refresh neither clears the action's
      // failure nor hides its own.
      const [error, setError] = React.useState(null);
      const [loadError, setLoadError] = React.useState(null);
      const [notice, setNotice] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [selected, setSelected] = React.useState('');
      const [packageKey, setPackageKey] = React.useState('');
      const [importPath, setImportPath] = React.useState('');
      const [preview, setPreview] = React.useState(null);
      const [values, setValues] = React.useState({});
      const [progress, setProgress] = React.useState(null);
      const [registerPath, setRegisterPath] = React.useState('');

      // Reading the snapshot only ever touches the load channel: a successful
      // refresh clears a stale load failure and leaves an action failure alone.
      const refresh = React.useCallback(async () => {
        try {
          const value = await request('/state');
          setState(value);
          setLoadError(null);
          return value;
        } catch (failure) {
          setLoadError({ code: failure.code || 'load-failed', details: failure.details || {} });
          return null;
        }
      }, []);

      React.useEffect(() => {
        void refresh();
      }, [refresh]);

      // While an action is in flight the panel would otherwise show a disabled
      // button and nothing else, even though imports run a package manager and a
      // wake enables bundles one by one. Poll the live progress so the steps are
      // visible *during* the work rather than only in its result.
      React.useEffect(() => {
        if (!busy) return undefined;
        let cancelled = false;
        const tick = async () => {
          try {
            const value = await request('/progress');
            if (!cancelled) setProgress(value);
          } catch {
            // Best-effort: the action's own result stays authoritative.
          }
        };
        void tick();
        const timer = window.setInterval(() => void tick(), 600);
        return () => {
          cancelled = true;
          window.clearInterval(timer);
        };
      }, [busy]);

      const run = React.useCallback(
        async (body, { confirm: needsConfirm } = {}) => {
          if (needsConfirm !== undefined && !window.confirm(needsConfirm)) return null;
          setBusy(true);
          // Starting a new action retires the previous action's failure; only a
          // new action clears that channel, never a refresh.
          setError(null);
          setNotice(null);
          setProgress(null);
          try {
            const snapshot = state ?? (await refresh());
            if (snapshot === null) return null;
            const value = await request('/execute', {
              operationId: operationId(),
              expectedRevision: snapshot.revision,
              ...body,
            });
            setNotice(value);
            setError(null);
            // Re-read after the action, but never let that read report on the
            // action: a refresh failure is its own, separately shown, failure.
            await refresh();
            return value;
          } catch (failure) {
            setError({ code: failure.code ?? 'operation-failed', details: failure.details ?? {} });
            await refresh();
            return null;
          } finally {
            setBusy(false);
          }
        },
        [state, refresh],
      );

      return { state, error, loadError, notice, busy, selected, setSelected, packageKey, setPackageKey, importPath, setImportPath, preview, setPreview, values, setValues, progress, registerPath, setRegisterPath, refresh, run, t };
    }

    /** The glyph for one step state, paired with a label for screen readers. */
    function stepMark(t, status) {
      if (status === 'done') return { glyph: '✔', label: t('stepDone') };
      if (status === 'active') return { glyph: '▸', label: t('stepActive') };
      if (status === 'failed') return { glyph: '✖', label: t('stepFailed') };
      if (status === 'skipped') return { glyph: '–', label: t('stepSkipped') };
      return { glyph: '·', label: t('stepPending') };
    }

    /**
     * Live progress for the running action, and the last finished one when
     * nothing is running. Steps arrive from `GET /progress`.
     * @param {object} props
     */
    function ProgressView({ t, progress }) {
      if (progress === null) return null;
      const running = progress.running ?? [];
      const shown = running.length > 0 ? running : (progress.recent ?? []).slice(0, 1);
      if (shown.length === 0) return null;

      return h(
        'div',
        { className: 'wsc-progress', 'data-workspace-scaffolds': 'progress' },
        ...shown.map((entry) =>
          h(
            'div',
            { key: entry.operationId },
            h(
              'div',
              { className: 'wsc-progress-head' },
              h('span', { className: `wsc-progress-status-${entry.status}` }, t(`status_${entry.status}`)),
              h('span', { className: 'wsc-progress-action' }, entry.action),
              h('span', { className: 'wsc-progress-phase' }, entry.error ? entry.error.code : entry.phase),
            ),
            h(
              'ul',
              { className: 'wsc-progress-steps' },
              ...(entry.steps ?? []).map((step, index) => {
                const mark = stepMark(t, step.status);
                return h(
                  'li',
                  { key: `${index}-${step.label}`, className: `wsc-step-${step.status}` },
                  h('span', { className: 'wsc-step-mark', role: 'img', 'aria-label': mark.label }, mark.glyph),
                  h('span', { className: 'wsc-step-label' }, step.label),
                  step.detail ? h('span', { className: 'wsc-step-detail' }, step.detail) : null,
                );
              }),
            ),
          ),
        ),
      );
    }

    /** @param {object} props */
    function Page({ t }) {
      const panel = usePanel(t);
      const { state, error, loadError, notice, busy } = panel;
      if (state === null) {
        const failed = error ?? loadError;
        return h('div', { className: 'wsc' }, h('style', null, css), h('p', { role: 'status' }, failed ? `${t('resultCode')}: ${failed.code}` : t('loading')));
      }

      const workspaces = state.workspaces ?? [];
      const packages = state.packages ?? [];
      const current = workspaces.find((workspace) => workspace.workspaceId === panel.selected) ?? workspaces[0] ?? null;
      const selectedKey = panel.packageKey || packages[0]?.key || '';

      return h(
        'div',
        { className: 'wsc', 'data-workspace-scaffolds': 'panel', 'aria-busy': busy },
        h('style', null, css),
        h('div', { className: 'wsc-row' },
          h('h3', null, t('title')),
          h('button', { type: 'button', onClick: () => void panel.refresh(), disabled: busy }, t('refresh')),
          h('span', { className: 'wsc-tag' }, `${t('revision')} ${state.revision}`),
          h('span', { className: 'wsc-tag' }, state.profileName ?? ''),
          // Which build is answering. Shown next to the profile's declared spec
          // so "an update is on disk but the process still holds old code" is
          // visible instead of having to be inferred from behaviour.
          h('span', { className: 'wsc-tag', 'data-plugin-version': state.pluginVersion ?? '' },
            `${t('version')} ${state.pluginVersion ?? t('versionUnknown')}`),
        ),
        h('p', { className: 'wsc-hint' }, t('intro')),
        state.restartPending
          ? h('p', { className: 'wsc-error', 'data-restart-pending': 'true' },
              `${t('restartPending')} ${t('profileSpec')}: ${state.profileSpec}`)
          : null,
        state.pluginVersion === null && state.profileSpec !== null
          ? h('p', { className: 'wsc-hint' }, `${t('profileSpec')}: ${state.profileSpec}`)
          : null,
        state.capabilities?.pluginManager !== true ? h('p', { className: 'wsc-error' }, t('capabilityMissing')) : null,
        state.capabilities?.workspaceRegistry !== true ? h('p', { className: 'wsc-error' }, t('workspaceMissing')) : null,
        h(ProgressView, { t, progress: panel.progress }),
        state.recoveryNote ? h('p', { className: 'wsc-error' }, t('recovery')) : null,
        state.automaticRestore === 'degraded' ? h('p', { className: 'wsc-error' }, t('degraded')) : null,
        state.runningAgents ? h('p', { className: 'wsc-hint' }, t('runningAgents')) : null,
        state.pendingSleeps?.length ? h('p', { className: 'wsc-hint' }, `${t('pendingSleeps')}: ${state.pendingSleeps.join(', ')}`) : null,

        RegisterSection(panel, t),
        ImportSection(panel, t),

        h('section', null,
          h('h3', null, t('sectionWorkspaces')),
          workspaces.length === 0 ? h('p', { className: 'wsc-hint' }, t('noWorkspaces')) : null,
          workspaces.length > 0
            ? h('div', { className: 'wsc-field' },
                h('label', { htmlFor: 'wsc-workspace' }, t('selectWorkspace')),
                h('select', {
                  id: 'wsc-workspace',
                  value: current?.workspaceId ?? '',
                  disabled: busy,
                  onChange: (event) => {
                    panel.setSelected(event.target.value);
                    panel.setPreview(null);
                  },
                }, workspaces.map((workspace) =>
                  h('option', { key: workspace.workspaceId, value: workspace.workspaceId },
                    `${workspace.title || workspace.lastKnownPath}${workspace.registered ? '' : ` (${t('missing')})`}`))),
              )
            : null,
          current === null ? null : WorkspaceCard(panel, current, t),
          (state.unmanagedWorkspaces ?? []).length > 0
            ? h('p', { className: 'wsc-hint' }, `${t('unmanagedWorkspaces')}: ${state.unmanagedWorkspaces.map((workspace) => workspace.title || workspace.path).join(', ')}`)
            : null,
        ),

        BindingsSection(panel, current, packages, selectedKey, t),
        PackagesSection(panel, packages, t),
        ResultSection(error, loadError, notice, t),
      );
    }

    /** @param {object} panel @param {object} t */
    function RegisterSection(panel, t) {
      return h('section', null,
        h('h3', null, t('sectionRegister')),
        h('p', { className: 'wsc-hint' }, t('registerHint')),
        h('div', { className: 'wsc-field' },
          h('label', { htmlFor: 'wsc-register' }, t('registerPath')),
          h('input', {
            id: 'wsc-register',
            name: 'wsc-register',
            type: 'text',
            value: panel.registerPath,
            autoComplete: 'off',
            spellCheck: false,
            disabled: panel.busy,
            onChange: (event) => panel.setRegisterPath(event.target.value),
          }),
        ),
        h('div', { className: 'wsc-row' },
          h('button', {
            type: 'button',
            disabled: panel.busy || panel.registerPath.trim().length === 0,
            onClick: () => void panel.run({ action: 'workspace-register', path: panel.registerPath.trim() }),
          }, t('registerRun')),
        ),
      );
    }

    /** @param {object} panel @param {object} t */
    function ImportSection(panel, t) {
      return h('section', null,
        h('h3', null, t('sectionImport')),
        h('p', { className: 'wsc-hint' }, t('importHint')),
        h('div', { className: 'wsc-field' },
          h('label', { htmlFor: 'wsc-import' }, t('importPath')),
          h('input', {
            id: 'wsc-import',
            name: 'wsc-import',
            type: 'text',
            value: panel.importPath,
            autoComplete: 'off',
            spellCheck: false,
            disabled: panel.busy,
            onChange: (event) => panel.setImportPath(event.target.value),
          }),
        ),
        h('div', { className: 'wsc-row' },
          h('button', {
            type: 'button',
            disabled: panel.busy || panel.importPath.trim().length === 0,
            onClick: () => void panel.run({ action: 'import', path: panel.importPath.trim() }),
          }, t('importRun')),
        ),
      );
    }

    /** @param {object} panel @param {object} workspace @param {object} t */
    function WorkspaceCard(panel, workspace, t) {
      const requirements = workspace.bindings.filter((binding) => binding.enabled && binding.required !== false);
      return h('div', { className: 'wsc-field' },
        h('div', { className: 'wsc-row' },
          h('span', { className: 'wsc-tag' }, `${t('state')}: ${workspace.requestedState === 'awake' ? t('awake') : t('sleeping')}`),
          h('span', { className: 'wsc-tag' }, `${t('ready')}: ${workspace.ready ? '✓' : '—'}`),
          requirements.length === 0 ? null : h('button', {
            type: 'button',
            disabled: panel.busy,
            onClick: () => void panel.run({ action: 'wake', workspaceId: workspace.workspaceId }),
          }, t('actionWake')),
          h('button', {
            type: 'button',
            disabled: panel.busy,
            onClick: () => void panel.run({ action: 'sleep', workspaceId: workspace.workspaceId }),
          }, t('actionSleep')),
        ),
        h('p', { className: 'wsc-hint' }, `${t('path')}: ${workspace.nativePath ?? workspace.lastKnownPath}`),
        (workspace.blockers ?? []).length > 0
          ? h('p', { className: 'wsc-error' }, `${t('blockers')}: ${workspace.blockers.map((blocker) => `${blocker.packageName} (${blocker.code})`).join('; ')}`)
          : null,
      );
    }

    /** @param {object} panel @param {object|null} workspace @param {object[]} packages @param {string} selectedKey @param {object} t */
    function BindingsSection(panel, workspace, packages, selectedKey, t) {
      const bindings = workspace?.bindings ?? [];
      return h('section', null,
        h('h3', null, t('sectionBindings')),
        workspace === null ? h('p', { className: 'wsc-hint' }, t('noWorkspaces')) : null,
        workspace !== null && bindings.length === 0 ? h('p', { className: 'wsc-hint' }, t('noWorkspaces')) : null,
        workspace !== null && packages.length > 0
          ? h('div', { className: 'wsc-row' },
              h('label', { htmlFor: 'wsc-package' }, t('packageLabel')),
              h('select', {
                id: 'wsc-package',
                value: selectedKey,
                disabled: panel.busy,
                onChange: (event) => panel.setPackageKey(event.target.value),
              }, packages.map((entry) => h('option', { key: entry.key, value: entry.key }, `${entry.packageName}@${entry.version}`))),
              h('button', {
                type: 'button',
                disabled: panel.busy || selectedKey === '',
                onClick: () => {
                  const chosen = packages.find((entry) => entry.key === selectedKey);
                  if (chosen === undefined) return;
                  void panel.run({
                    action: 'bind',
                    workspaceId: workspace.workspaceId,
                    packageName: chosen.packageName,
                    version: chosen.version,
                  });
                },
              }, t('addTo')),
            )
          : null,
        bindings.length === 0 ? null : h('table', null,
          h('thead', null, h('tr', null,
            h('th', null, t('columnPackage')),
            h('th', null, t('columnVersion')),
            h('th', null, t('columnNative')),
            h('th', null, t('columnArchive')),
            h('th', null, t('columnActions')),
          )),
          h('tbody', null, bindings.map((binding) =>
            h('tr', { key: binding.id, 'data-binding': binding.id },
              h('td', null,
                binding.packageName,
                binding.shared ? h('span', { className: 'wsc-tag' }, t('shared')) : null,
                binding.package.pinned ? h('span', { className: 'wsc-tag' }, t('pinnedTag')) : null,
                binding.package.ownership === 'external' ? h('span', { className: 'wsc-tag' }, t('externalTag')) : null,
                VariableFields(panel, binding, t),
              ),
              h('td', null, binding.version),
              h('td', null,
                `${t(nativeLabel(binding.package.status))}`,
                h('br'),
                binding.package.enabled ? t('nativeEnabled') : t('nativeDisabled'),
              ),
              h('td', null, binding.package.archivePresent ? t('archiveYes') : t('archiveNo')),
              h('td', null, h('div', { className: 'wsc-row' },
                h('button', {
                  type: 'button',
                  disabled: panel.busy,
                  onClick: async () => {
                    const value = await panel.run({
                      action: 'template-preview',
                      workspaceId: workspace.workspaceId,
                      bindingId: binding.id,
                      values: variablesFor(panel.values, binding),
                    });
                    if (value !== null && typeof value?.previewId === 'string') panel.setPreview(value);
                  },
                }, t('actionPreview')),
                h('button', {
                  type: 'button',
                  disabled: panel.busy,
                  onClick: () => void panel.run({
                    action: 'unbind',
                    workspaceId: workspace.workspaceId,
                    bindingId: binding.id,
                  }, { confirm: t('confirmUnbind') }),
                }, t('actionUnbind')),
              )),
            )),
        )),
        panel.preview === null ? null : PreviewCard(panel, t),
      );
    }

    /**
     * Collect the values typed for one binding's declared variables, falling
     * back to the descriptor default when the field was left empty.
     * @param {Record<string, string>} typed
     * @param {object} binding
     * @returns {Record<string, string>}
     */
    function variablesFor(typed, binding) {
      const declared = binding.package?.scaffold?.variables ?? {};
      const values = {};
      for (const [name, definition] of Object.entries(declared)) {
        const key = `${binding.id}:${name}`;
        const entered = typed[key];
        values[name] = typeof entered === 'string' && entered.length > 0 ? entered : (definition.default ?? '');
      }
      return values;
    }

    /**
     * Render one text input per declared template variable of a binding.
     * @param {object} panel
     * @param {object} binding
     * @param {object} t
     */
    function VariableFields(panel, binding, t) {
      const declared = binding.package?.scaffold?.variables ?? {};
      const names = Object.keys(declared);
      if (names.length === 0) return null;
      return h('div', { className: 'wsc-field' },
        h('span', { className: 'wsc-hint' }, t('variables')),
        ...names.map((name) => {
          const key = `${binding.id}:${name}`;
          const definition = declared[name];
          return h('div', { className: 'wsc-field', key },
            h('label', { htmlFor: `wsc-var-${key}` }, `${name}${definition.required ? ' *' : ''}`),
            h('input', {
              id: `wsc-var-${key}`,
              name: `wsc-var-${key}`,
              type: 'text',
              autoComplete: 'off',
              spellCheck: false,
              placeholder: definition.default ?? '',
              disabled: panel.busy,
              value: panel.values[key] ?? '',
              onChange: (event) => panel.setValues({ ...panel.values, [key]: event.target.value }),
            }),
          );
        }),
      );
    }

    /** @param {object} panel @param {object} t */
    function PreviewCard(panel, t) {
      const preview = panel.preview;
      const files = preview.files ?? [];
      return h('div', { className: 'wsc-field', 'data-preview': preview.previewId },
        h('h3', null, t('templateTitle')),
        h('p', { className: 'wsc-hint' },
          `${t('templateCreatable')}: ${files.filter((file) => file.status === 'create').length} · ` +
          `${t('templateIdentical')}: ${files.filter((file) => file.status === 'identical').length} · ` +
          `${t('templateConflict')}: ${files.filter((file) => file.status === 'conflict').length}`),
        (preview.blocking ?? []).length > 0 ? h('p', { className: 'wsc-error' }, t('templateBlocked')) : null,
        files.length === 0
          ? h('p', { className: 'wsc-hint' }, t('templateEmpty'))
          : h('ul', { className: 'wsc-files' }, files.map((file) =>
              h('li', { key: file.target, className: `wsc-${file.status}` }, `${file.target} — ${file.status}`))),
        h('div', { className: 'wsc-row' },
          h('button', {
            type: 'button',
            disabled: panel.busy || (preview.blocking ?? []).length > 0,
            onClick: () => void panel.run({ action: 'template-apply', previewId: preview.previewId }),
          }, t('actionApply')),
          h('button', { type: 'button', disabled: panel.busy, onClick: () => panel.setPreview(null) }, t('close')),
        ),
      );
    }

    /** @param {object} panel @param {object[]} packages @param {object} t */
    function PackagesSection(panel, packages, t) {
      return h('section', null,
        h('h3', null, t('sectionPackages')),
        packages.length === 0 ? h('p', { className: 'wsc-hint' }, t('noPackages')) : null,
        packages.length === 0 ? null : h('table', null,
          h('thead', null, h('tr', null,
            h('th', null, t('columnPackage')),
            h('th', null, t('columnNative')),
            h('th', null, t('columnArchive')),
            h('th', null, t('columnHolders')),
            h('th', null, t('columnActions')),
          )),
          h('tbody', null, packages.map((entry) =>
            h('tr', { key: entry.key, 'data-package': entry.key },
              h('td', null, entry.packageName, h('br'), h('span', { className: 'wsc-tag' }, entry.version)),
              h('td', null,
                `${t(nativeLabel(entry.nativeStatus))}`,
                h('br'),
                entry.enabled ? t('nativeEnabled') : t('nativeDisabled'),
              ),
              h('td', null, entry.archivePresent ? t('archiveYes') : t('archiveNo')),
              h('td', null, (entry.holders ?? []).length === 0 ? '—' : entry.holders.join(', ')),
              h('td', null, h('div', { className: 'wsc-row' },
                h('button', {
                  type: 'button',
                  disabled: panel.busy,
                  onClick: () => void panel.run({ action: 'set-pin', packageKey: entry.key, pinned: !entry.pinned }),
                }, entry.pinned ? t('actionUnpin') : t('actionPin')),
                h('button', {
                  type: 'button',
                  disabled: panel.busy || !entry.archivePresent,
                  onClick: () => void panel.run({ action: 'delete-archive', archiveSha256: entry.archiveSha256 }, { confirm: t('confirmDelete') }),
                }, t('actionDeleteArchive')),
              )),
            )),
        )),
      );
    }

    /**
     * The last action's outcome.
     *
     * Both failure channels are shown at once when both are set, the action's
     * own failure first because it is what the user just asked for. Only the
     * action channel suppresses the success notice: a read that failed after the
     * action succeeded must not retract the news that the action took effect.
     * @param {object|null} error
     * @param {object|null} loadError
     * @param {any} notice
     * @param {object} t
     */
    function ResultSection(error, loadError, notice, t) {
      if (error === null && loadError === null && notice === null) return null;
      return h('section', null,
        h('h3', null, t('sectionResult')),
        error === null ? null : h('p', { className: 'wsc-error', role: 'alert', 'data-error-source': 'operation' }, `${t('resultCode')}: ${error.code}`),
        error === null ? null : h('pre', null, JSON.stringify(error.details, null, 2)),
        loadError === null ? null : h('p', { className: 'wsc-error', role: 'alert', 'data-error-source': 'load' }, `${t('loadFailed')}: ${loadError.code}`),
        loadError === null ? null : h('pre', null, JSON.stringify(loadError.details, null, 2)),
        error === null && notice?.status === 'pending-idle' ? h('p', { className: 'wsc-hint' }, t('pendingIdle')) : null,
        error === null && notice?.restartRequired ? h('p', { className: 'wsc-error' }, t('restartRequired')) : null,
        error === null && notice !== null && notice.status !== 'pending-idle' && !notice.restartRequired
          ? h('p', { className: 'wsc-ok' }, t('resultOk'))
          : null,
        error === null && notice !== null ? h('pre', null, JSON.stringify(notice, null, 2)) : null,
      );
    }

    /** @param {string} status @returns {string} */
    function nativeLabel(status) {
      switch (status) {
        case 'match':
          return 'nativeMatch';
        case 'mismatch':
          return 'nativeMismatch';
        case 'error':
          return 'nativeError';
        default:
          return 'nativeAbsent';
      }
    }

    return {
      inject: ['slots', 'locale'],
      /**
       * @param {object} ctx
       * @returns {void}
       */
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }));
        const t = ctx.locale.bind(NS);
        /** Bind the locale once here so the panel never depends on slot props. */
        const BoundPage = (props) => h(Page, { ...props, t });
        ctx.effect(() =>
          ctx.slots.inject('plugins.bundle.config', () =>
            ctx.slots.register(
              {
                name: 'plugins.bundle.config',
                key: 'dsh-workspace-scaffolds',
                locale: NS,
                order: 40,
              },
              BoundPage,
            ),
          ),
        );
      },
    };
  },
});
