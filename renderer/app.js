"use strict";
// Scope: Flow list, Profile and the supplied four-state Design recording UI.
// Category/Service Level catalogs, Validation and remote services are not supplied.
// SVG assets are embedded from provided files.
const rowIcons = {
  edit: '<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" viewBox="0 0 192 192" class="icon" aria-hidden="true" focusable="false" fill="currentColor"><path d="M16 148h40v8H16zm154.85-70.65-2.829 2.828-.021-.021-65.955 65.955-39.543 9.886 9.886-39.543 68.763-68.805c8.187-8.187 21.51-8.187 29.698 0 8.188 8.189 8.188 21.511 0 29.7M100 136.842l54.35-54.35-18.301-18.385L81.657 118.5zm-26.502 8.16 18.678-4.67-14.009-14.009zm91.694-91.696c-4.858-4.859-12.638-5.06-17.74-.603l-5.747 5.747 18.301 18.386 5.79-5.79c4.456-5.1 4.255-12.88-.604-17.74" /></svg>',
  delete:
    '<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" viewBox="0 0 192 192" class="icon" aria-hidden="true" focusable="false" fill="currentColor"><path d="M152 56H40V40h112zm-12 104c0 4.411-3.59 8-8 8H60c-4.412 0-8-3.589-8-8V64h16v56h8V64h16v56h8V64h16v56h8V64h16zM80 24h32c4.411 0 8 3.588 8 8H72c0-4.412 3.589-8 8-8m80 8h-32c0-8.822-7.178-16-16-16H80c-8.823 0-16 7.178-16 16H32v32h12v96c0 8.822 7.178 16 16 16h72c8.822 0 16-7.178 16-16V64h12z" /></svg>',
  run: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4 19 12 6 20Z" fill="none" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/></svg>',
};
const flowData = [];

const $ = (id) => {
  const root = document.querySelector(
    "#designPanel > .recording-layout:not([hidden])",
  );
  return (
    (root &&
      [...root.querySelectorAll("#" + CSS.escape(id))].find(
        (element) => !element.closest("[hidden]"),
      )) ||
    document.getElementById(id)
  );
};

const escapeHTML = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

let appliedName = "";
let  appliedVersion = "";
let appliedSearch = "";
let activeStatus = "All";
let currentFlow = null;
let trigger = null;
let initialName = "";
let savedScroll = 0;
const profileDrafts = new Map();

function nextTaskflowCode() {
  return (
    "TASKFLOW-" +
    String(
      Math.max(
        0,
        ...flowData.map((flow) => Number(flow.code.match(/\d+$/)?.[0]) || 0),
      ) + 1,
    ).padStart(3, "0")
  );
}

function saveProfile() {
  if (!validateProfileServices()) return;
  const draft = profileDraft(),
    code = currentFlow?.code || nextTaskflowCode(),
    snapshot = {
      code,
      name: $("flowName").value.trim(),
      description: $("flowDescription").value.trim(),
      serviceLines: [...draft.serviceLines],
      versions: draft.versions.map((version) => ({ ...version })),
      enabled: draft.versions.some((version) => version.enabled),
      version: currentFlow?.version || "r1",
      category: currentFlow?.category || "",
      status: currentFlow?.status || "Ready",
    };
  if (currentFlow) Object.assign(currentFlow, snapshot);
  else {
    currentFlow = snapshot;
    flowData.push(currentFlow);
    profileDrafts.set(code, draft);
    profileDrafts.delete("new");
    activeFlowKey = code;
  }
  $("drawerTitle").textContent = code.replace("TASKFLOW", "Taskflow");
  draft.name = snapshot.name;
  draft.description = snapshot.description;
  render();
  $("profileSaveStatus").textContent = "Saved.";
  closeDrawer();
}

function profileDraft() {
  const key = currentFlow?.code || "new";
  if (!profileDrafts.has(key))
    profileDrafts.set(key, {
      name: currentFlow?.name || "",
      description: currentFlow?.description || "",
      serviceLines: [...(currentFlow?.serviceLines || ["", "", "", ""])],
      versions: (currentFlow?.versions || [{ name: "V1", enabled: false }]).map(
        (version) => ({ ...version }),
      ),
    });
  return profileDrafts.get(key);
}

function renderVersionManagement() {
  const draft = profileDraft();
  $("versionManagementRows").innerHTML = draft.versions
    .map(
      (version, index) =>
        `
      <div class="version-management-row">
        <div class="field version-value-field">
          <label class="field-label" for="${index === 0 ? "flowVersion" : "flowVersion" + index}">Version</label>
          <input id="${index === 0 ? "flowVersion" : "flowVersion" + index}" value="${escapeHTML(version.name)}" readonly>
        </div>
        <div class="field version-state-field">
          <label class="field-label" for="${index === 0 ? "flowStatus" : "flowStatus" + index}">Status</label>
          <div class="version-status-field">
            <select id="${index === 0 ? "flowStatus" : "flowStatus" + index}" data-version-index="${index}" aria-label="${escapeHTML(version.name)} status">
              <option value="Active" ${version.enabled ? "selected" : ""}>Active</option>
              <option value="Deactive" ${!version.enabled ? "selected" : ""}>Deactive</option>
            </select>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 9 7 7 7-7"/></svg>
          </div>
        </div>
      </div>`,
    )
    .join("");
}

function commitVersionStatus(index, value) {
  const draft = profileDraft();
  draft.versions[index].enabled = value === "Active";
  if (currentFlow) {
    currentFlow.versions = draft.versions.map((version) => ({ ...version }));
    currentFlow.enabled = currentFlow.versions.some(
      (version) => version.enabled,
    );
    render();
  }
}

function rowIcon(name, code, disabled = false) {
  return `
  <button 
    type="button" 
    class="icon-button" 
    aria-label="${name[0].toUpperCase() + name.slice(1)} ${code}" title="${name[0].toUpperCase() + name.slice(1)}" 
    data-action="${name}" 
    data-code="${code}" ${disabled ? "disabled" : ""}
  >
    ${rowIcons[name]}
  </button>`;
}

function render() {
  const rows = flowData.filter(
    (f) =>
      (!appliedSearch ||
        (f.code + " " + f.name + " " + f.description)
          .toLowerCase()
          .includes(appliedSearch)) &&
      (!appliedName || f.name.toLowerCase().includes(appliedName)) &&
      (!appliedVersion || f.version.toLowerCase().includes(appliedVersion)) &&
      (activeStatus === "All" ||
        (activeStatus === "Active" ? f.enabled : !f.enabled)),
  );
  $("flowRows").innerHTML =
    rows
      .map(
        (f) =>
          `
        <tr>
          <td>
            <a class="code-link" href="#${f.code}" data-open="${f.code}">${f.code}</a>
          </td>
          <td>${escapeHTML(f.name)}</td>
          <td><span class="flow-description" title="${escapeHTML(f.description)}">${escapeHTML(f.description)}</span></td>
          <td>${escapeHTML(f.version)}</td>
          <td>
            <span class="flow-enabled ${f.enabled ? "active" : "deactive"}">
              <span class="flow-status-dot" aria-hidden="true"></span>
              ${f.enabled ? "Active" : "Deactive"}
            </span>
          </td>
          <td class="action-cell">
            <div class="row-actions">
              ${rowIcon("edit", f.code)}${rowIcon("run", f.code, f.enabled)}${rowIcon("delete", f.code, true)}
            </div>
          </td>
        </tr>`,
      )
      .join("") ||
    '<tr><td class="empty" colspan="6">No matching flows.</td></tr>';

  $("range").textContent = rows.length
  ? `1 - ${rows.length} of ${rows.length} items`
  : "0 - 0 of 0 items";

  $("currentPage").disabled = !rows.length;
  document.querySelectorAll("[data-status]").forEach((b) => {
    const active = b.dataset.status === activeStatus;
    b.setAttribute("aria-selected", String(active));
    b.tabIndex = active ? 0 : -1;
  });
}

function openDrawer(code, source) {
  currentFlow = code ? flowData.find((f) => f.code === code) : null;
  trigger = source;
  savedScroll = window.scrollY;
  $("drawerTitle").textContent = code
    ? code.replace("TASKFLOW", "Taskflow")
    : nextTaskflowCode().replace("TASKFLOW", "Taskflow");
  $("profileSaveStatus").textContent = "";
  
  if (!code) {
    profileDrafts.delete("new");
    // Clear any leftover transient design state for the previous new-flow session.
    const orphanedNewCode = activeFlowKey;
    if (orphanedNewCode && !flowData.find((f) => f.code === orphanedNewCode)) {
      recordingSessions.delete(orphanedNewCode);
    }
    // initializeDrawerRecording will generate the final activeFlowKey for the new flow.
  }
  
  const draft = profileDraft();
  $("flowName").value = draft.name;
  $("flowDescription").value = draft.description;
  initialName = draft.name;
  renderVersionManagement();
  
  document
    .querySelectorAll("[data-service-index]")
    .forEach(
      (select) =>
        (select.value =
          draft.serviceLines[Number(select.dataset.serviceIndex)] || ""),
    );
  closePopup("category");
  closePopup("service");
  initializeDrawerRecording(code);
  $("drawer").showModal();
  document.body.style.overflow = "hidden";
  $("flowName").focus({ preventScroll: true });
}

async function closeDrawer() {
  const session = recordingSession();
  if (session.stage === "recording") {
    if (!(await confirmWorkspaceAction("Stop recording and close?"))) return;
    await finishBrowserRecording();
  }
  const draft = profileDraft();
  draft.name = $("flowName").value;
  draft.description = $("flowDescription").value;
  closePopup("service");
  recordingSession().aiOpen = false;
  renderAIPanel();
  $("drawer").close();
  document.body.style.overflow = "";
  window.scrollTo({ top: savedScroll, behavior: "instant" });
  trigger?.focus({ preventScroll: true });
}

function closePopup(type) {
  const popup = $(type === "category" ? "categoryPopup" : "servicePopup");
  const button = $(type === "category" ? "category" : "serviceLine");
  if (popup) popup.hidden = true;
  if (button && popup) button.setAttribute("aria-expanded", "false");
}

function togglePopup(type) {
  const popup = $(type === "category" ? "categoryPopup" : "servicePopup");
  const button = $(type === "category" ? "category" : "serviceLine");
  const willOpen = popup.hidden;
  popup.hidden = !willOpen;
  button.setAttribute("aria-expanded", String(willOpen));
  if (willOpen)
    $(type === "category" ? "categorySearch" : "serviceSearch").focus();
}

$("toggleNav").onclick = () => {
  const open = $("shell").classList.toggle("expanded");
  $("toggleNav").setAttribute("aria-expanded", String(open));
  $("toggleNav").setAttribute(
    "aria-label",
    open ? "Collapse navigation" : "Expand navigation",
  );
  $("toggleNav").title = open ? "Collapse navigation" : "Expand navigation";
};

function updateFilterExpansion() {
  const button = $("expandFilters"),
    expanded = !$("advancedFilters").hidden,
    count = Number(!!appliedName) + Number(!!appliedVersion),
    label = expanded ? "Collapse" : "Expand";
  button.setAttribute("aria-expanded", String(expanded));
  button.setAttribute("aria-label", label);
  button.title = label;
  button.dataset.copyKey = expanded
    ? "filter.action.collapse"
    : "filter.action.expand";
  button.querySelector("span").textContent = label;
  button.dataset.activeCount = !expanded && count ? String(count) : "";
}

$("expandFilters").onclick = () => {
  $("advancedFilters").hidden = !$("advancedFilters").hidden;
  updateFilterExpansion();
};

$("query").onsubmit = (e) => {
  e.preventDefault();
  appliedSearch = $("search").value.trim().toLowerCase();
  appliedName = $("filterName").value.trim().toLowerCase();
  appliedVersion = $("filterVersion").value.trim().toLowerCase();
  closePopup("category");
  render();
  updateFilterExpansion();
};

$("reset").onclick = () => {
  $("search").value = "";
  $("filterName").value = "";
  $("filterVersion").value = "";
  appliedSearch = "";
  appliedName = "";
  appliedVersion = "";
  activeStatus = "All";
  $("categorySearch").value = "";
  closePopup("category");
  render();
  updateFilterExpansion();
};

document.querySelectorAll("[data-status]").forEach((b) => {
  b.onclick = () => {
    activeStatus = b.dataset.status;
    render();
  };
  b.onkeydown = (e) => {
    const tabs = [...document.querySelectorAll("[data-status]")];
    let index = tabs.indexOf(b);
    if (e.key === "ArrowRight") index = (index + 1) % tabs.length;
    else if (e.key === "ArrowLeft")
      index = (index + tabs.length - 1) % tabs.length;
    else if (e.key === "Home") index = 0;
    else if (e.key === "End") index = tabs.length - 1;
    else return;
    e.preventDefault();
    tabs[index].click();
    tabs[index].focus();
  };
});

$("flowRows").onclick = (e) => {
  const link = e.target.closest("[data-open]");
  const edit = e.target.closest('[data-action="edit"]');
  if (link) {
    e.preventDefault();
    openDrawer(link.dataset.open, link);
  } else if (edit) openDrawer(edit.dataset.code, edit);
};

$("create").onclick = (e) => openDrawer(null, e.currentTarget);
$("close").onclick = closeDrawer;
$("profileSave").onclick = saveProfile;
$("profilePanel").addEventListener("input", () => {
  $("profileSaveStatus").textContent = "";
});
$("flowName").oninput = (e) => {
  e.target.setCustomValidity("");
  profileDraft().name = e.target.value;
};
$("flowDescription").oninput = (e) => {
  e.target.setCustomValidity("");
  profileDraft().description = e.target.value;
};
$("versionManagementRows").onchange = (e) => {
  if (e.target.matches("[data-version-index]"))
    commitVersionStatus(Number(e.target.dataset.versionIndex), e.target.value);
};
$("drawer").addEventListener("cancel", (e) => {
  e.preventDefault();
  closeDrawer();
});
$("category").onclick = () => togglePopup("category");

document.querySelectorAll("[data-service-index]").forEach((control) => {
  const save = () => {
    control.setCustomValidity("");
    profileDraft().serviceLines[Number(control.dataset.serviceIndex)] =
      control.value;
  };
  control.oninput = save;
  control.onchange = save;
});

for (const type of ["category"]) {
  $(type === "category" ? "categorySearch" : "serviceSearch").onkeydown = (
    e,
  ) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closePopup(type);
      $(type === "category" ? "category" : "serviceLine").focus();
    }
  };
}

document.addEventListener("click", (e) => {
  if (!e.target.closest("#categoryField")) closePopup("category");
  if (!e.target.closest(".form-select")) closePopup("service");
});

function validateProfileServices() {
  for (const control of document.querySelectorAll(
    "#profilePanel input[required],#profilePanel select[required]",
  )) {
    control.setCustomValidity(
      control.value.trim() ? "" : "Please complete this field.",
    );
    if (!control.reportValidity()) return false;
  }
  return true;
}

function embeddedBrowserHTML(route) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;background:#f7f8fa;font:14px Arial,'Microsoft YaHei',sans-serif;color:#111}button,input,select{font:inherit}header{height:46px;background:#005078;color:#fff;display:flex;align-items:center;justify-content:space-between;padding:0 14px;font-size:14px;font-weight:bold}header span{font-size:11px;font-weight:normal}nav{height:40px;background:#fff;display:flex;padding:0 14px;gap:16px;border-bottom:1px solid #dde3ea}nav button{border:0;background:none;color:#6d7d89;padding:0 6px;position:relative}nav button.active{color:#0084ce;border-bottom:2px solid #0084ce}main{padding:14px}.company{display:flex;align-items:center;gap:14px;margin-bottom:14px}.avatar{width:40px;height:40px;background:#e3f5ff;color:#0093d7;display:flex;align-items:center;justify-content:center;font-size:20px}h1{font-size:14px;margin:3px 0;font-weight:700}.company p{font-size:10px;color:#73828d;margin:5px 0}section{background:#fff;border:1px solid #dce3eb;padding:14px;margin-bottom:7px}h2{font-size:14px;margin:0 0 15px}dl{display:grid;grid-template-columns:34% 66%;gap:12px 8px;margin:0}dt{color:#788893}dd{margin:0}.saved{float:right;color:#07945d;font-size:12px}input,select{width:100%;height:30px;border:1px solid #d8dfe8;padding:3px 6px;background:white}.button{border:1px solid #007bc0;color:#007bc0;background:white;padding:6px 14px;margin-top:14px}</style></head><body><header>Indirect Procurement Workbench<span>Demo</span></header><nav>${["Suppliers", "Draft", "Receipts"].map((v) => `<button data-route="${v.toLowerCase()}" class="${route === v.toLowerCase() ? "active" : ""}">${v}</button>`).join("")}</nav><main>${route === "suppliers" ? `<div class="company"><div class="avatar">A</div><div><h1>安达设施服务（虚构）</h1><p>DEMO-V001 · Indirect Procurement / Facility Services</p></div></div><section><h2>Supplier master data</h2><dl><dt>Country / Currency</dt><dd>China / CNY</dd><dt>Purchasing contact</dt><dd>Supplier A · Demo contact</dd><dt>Supplier rating</dt><dd>B · Verified</dd><dt>Annual quotation</dt><dd>264,000.00</dd><dt>Total amount</dt><dd>292560</dd><dt>Delivery / SLA</dt><dd>12 days / 24-hour response</dd></dl></section><section><span class="saved">Saved</span><h2>Requirement draft</h2><dl><dt>Title</dt><dd>苏州示范工厂 2027 年度设施维护服务</dd><dt>Service date</dt><dd>2027-01-01</dd></dl></section>` : route === "draft" ? `<section><h2>Requirement draft</h2><dl><dt>Title</dt><dd><input value="苏州示范工厂 2027 年度设施维护服务" aria-label="Title"></dd><dt>Service date</dt><dd><input value="2027-01-01" aria-label="Service date" type="date"></dd><dt>Total amount</dt><dd><input value="292560" aria-label="Total amount"></dd></dl></section>` : `<section><h2>Receipts</h2></section>`}</main><script>document.addEventListener('click',e=>{const b=e.target.closest('[data-route]');if(b)parent.postMessage({type:'flowlink-route',route:b.dataset.route},'*');});document.addEventListener('input',e=>{if(e.target.matches('input,select'))parent.postMessage({type:'flowlink-input',target:e.target.getAttribute('aria-label'),value:e.target.value},'*');});<\/script><\/body><\/html>`;
}
// Node changes and destructive actions share this review step; Record starts immediately.
function confirmWorkspaceAction(message) {
  const dialog = $("actionConfirmDialog"),
    trigger = document.activeElement;
  if (dialog.open) return Promise.resolve(false);
  $("actionConfirmMessage").textContent = message;
  return new Promise((resolve) => {
    const finish = (value) => {
      dialog.close();
      dialog.oncancel = null;
      if (trigger?.isConnected) trigger.focus();
      resolve(value);
    };
    $("actionConfirmCancel").onclick = () => finish(false);
    $("actionConfirmYes").onclick = () => finish(true);
    dialog.oncancel = (e) => {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    };
    dialog.showModal();
    const state = recordingSession();
    let region = state.workspaceElement;
    if (!region || region.hidden || region.getBoundingClientRect().width <= 0) {
      region = !$("designPanel").hidden
        ? $("designPanel")
        : !$("profilePanel").hidden
          ? $("profilePanel")
          : $("drawer");
    }
    if (!region || region.getBoundingClientRect().width <= 0)
      region = document.body;
    const bounds = region.getBoundingClientRect();
    dialog.style.width =
      Math.min(640, Math.max(400, bounds.width - 64), innerWidth - 48) + "px";
    const box = dialog.getBoundingClientRect();
    dialog.style.inset = "auto";
    dialog.style.margin = "0";
    dialog.style.left =
      Math.max(
        24,
        Math.min(
          innerWidth - box.width - 24,
          bounds.left + (bounds.width - box.width) / 2,
        ),
      ) + "px";
    dialog.style.top =
      Math.max(
        24,
        Math.min(
          innerHeight - box.height - 24,
          bounds.top + (bounds.height - box.height) / 2,
        ),
      ) + "px";
    $("actionConfirmCancel").focus();
  });
}

const recordingTestURL = "https://bosch.com.cn";
// Browser tabs persist independently; one recording spans every active tab.
const recordingSessions = new Map();
function designIcon(name) {
  const paths = {
    back: "M15 4 7 12l8 8",
    forward: "m9 4 8 8-8 8",
    reload: "M19 8a8 8 0 1 0 1 8M19 3v5h-5",
    plus: "M12 4v16M4 12h16",
    close: "m5 5 14 14M19 5 5 19",
    delete: "M4 7h16M9 3h6l1 4H8l1-4ZM6 7l1 14h10l1-14M10 10v7M14 10v7",
    edit: "m4 16 11-11a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4ZM13 7l3 3",
    up: "M12 20V4M5 11l7-7 7 7",
    down: "M12 4v16M5 13l7 7 7-7",
  };
  return `<svg class="design-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${paths[name] || ""}"/></svg>`;
}

const recordingDeleteIcon = designIcon("delete");
const summaryTabs = [
  "Process",
  "Instruction",
  "Reference",
  "Metric",
  "Test",
  "Record",
];
function summaryTabId(name) {
  return name === "Instruction"
    ? "summaryTabSteps"
    : name === "Record"
      ? "summaryTabRecords"
      : "summaryTab" + name;
}
const leaveGroupSeed = [
  {
    name: "进入请假申请",
    steps: ["打开 OA 系统", "进入请假申请页面", "点击新建申请"],
  },
  {
    name: "填写请假信息",
    steps: [
      "选择请假类型",
      "填写开始与结束时间",
      "填写请假原因",
      "上传证明附件（如需）",
    ],
  },
  {
    name: "确认并提交",
    steps: ["确认审批人", "核对申请信息", "点击提交", "查看提交结果"],
  },
];

const referenceOperation = leaveGroupSeed.flatMap((group) => group.steps);

function testStepLabel(step, index) {
  if (!step) return `Step ${index + 1}`;
  const kind = step.kind || "action";
  const target = step.target?.candidates?.[0]?.value;
  const targetText =
    typeof target === "string" ? target : target?.name || target?.role || "";
  const extra = step.url
    ? step.url
    : step.value || step.text || targetText || "";
  return `${kind}${extra ? ` · ${String(extra).replace(/^(?:https?:\/\/)/, "")}` : ""}`;
}

function testWorkspaceMarkup(item) {
  const steps = item?.testFlowSteps?.length
    ? item.testFlowSteps
    : item?.steps || [];
  const results = item?.testResults || [];
  const running = item?.testRunning === true;
  const rows = steps.length
    ? steps
        .map((step, index) => {
          const result = results[index];
          const status = result?.status || "pending";
          const error = result?.error?.message
            ? `<div class="test-step-error">${escapeHTML(result.error.message)}</div>`
            : "";
          return `<div class="test-step status-${status}"><span class="test-step-index">${String(index + 1).padStart(2, "0")}</span><span class="test-step-name">${escapeHTML(typeof step === "string" ? step : testStepLabel(step, index))}</span><span class="test-step-status">${status === "pass" ? "Passed" : status === "fail" ? "Failed" : status === "running" ? "Running" : "Pending"}</span>${error}</div>`;
        })
        .join("")
    : `<div class="test-empty">No executable steps in this recording.</div>`;
  return `<div class="test-workspace"><div class="test-toolbar"><button class="btn" id="runRecordingTest" type="button" ${running || !item?.recordingId ? "disabled" : ""}>${running ? "Running…" : "Run"}</button><button class="btn secondary" id="stopRecordingTest" type="button" ${!running ? "disabled" : ""}>Stop</button></div><div class="test-step-list" aria-live="polite">${rows}</div></div>`;
}

function resetTestExecutionStatus(item) {
  if (!item) return;
  const steps = item.testFlowSteps?.length
    ? item.testFlowSteps
    : item.steps || [];
  item.testRunning = false;
  item.testResults = steps.map(() => ({ status: "pending" }));
}

function analysisResultMarkup(active) {
  const item = currentAssistantItem(),
    steps = item?.steps || referenceOperation;
  if (active === "Process") return processMapMarkup(item);
  if (active === "Record") return recordingMediaMarkup(item);
  if (active === "Operation")
    return `<ol class="analysis-operation">${steps.map((line) => `<li>${escapeHTML(line)}</li>`).join("")}</ol>`;
  if (active === "Instruction") return editableStepsMarkup(item);
  if (active === "Reference") return referenceFilesMarkup(item);
  if (active === "Metric") return metricMarkup(item);
  if (active === "Test") return testWorkspaceMarkup(item);
  return "";
}

let activeFlowKey = "TASKFLOW-001",
  drawerView = "Profile",
  recordingSequence = 1102,
  browserPageSequence = 0;

function generatedRecordingName() {
  const now = new Date(),
    yyyy = String(now.getFullYear()),
    mm = String(now.getMonth() + 1).padStart(2, "0"),
    dd = String(now.getDate()).padStart(2, "0");
  return `RECORD-${yyyy}-${mm}-${dd}`;
}

function createBrowserPage(url = "", showGuide = false) {
  return {
    showGuide,
    id: "page-" + ++browserPageSequence,
    url,
    draftURL: url,
    route:
      url.match(/^local:\/\/procurement\/(suppliers|draft|receipts)$/)?.[1] ||
      "suppliers",
    history: [url],
    historyIndex: 0,
    frame: null,
  };
}

function recordingSession(key = activeFlowKey) {
  if (!recordingSessions.has(key)) {
    const first = createBrowserPage(recordingTestURL, true);
    recordingSessions.set(key, {
      stage: "guide",
      view: "browser",
      items: [],
      focused: null,
      allExplicit: false,
      url: "",
      route: "suppliers",
      history: [""],
      historyIndex: 0,
      pending: null,
      listWidth: 298,
      aiWidth: 320,
      browserTabs: [first],
      activeBrowserTab: first.id,
      browserElement: null,
      guideAssistant: {
        steps: [...recordingGuideSteps],
        chat: [],
        chatDraft: "",
      },
    });
  }
  return recordingSessions.get(key);
}

function activeBrowserPage(state = recordingSession()) {
  return (
    state.browserTabs.find((page) => page.id === state.activeBrowserTab) ||
    state.browserTabs[0]
  );
}

function syncBrowserSession(state = recordingSession()) {
  const page = activeBrowserPage(state);
  state.url = page.url;
  state.route = page.route;
  state.history = page.history;
  state.historyIndex = page.historyIndex;
  state.draftURL = page.draftURL;
  return page;
}

function initializeDrawerRecording(code) {
  activeFlowKey = code || nextTaskflowCode();
  recordingSession();
  showDrawerTab("Profile");
}

function showDrawerTab(view) {
  const state = recordingSession();
  if (state.stage === "recording" && view !== "Design") return;
  drawerView = view;
  const design = view === "Design";
  $("profilePanel").hidden = design;
  $("designPanel").hidden = !design;
  for (const name of ["Profile", "Design"]) {
    const button = $(name === "Profile" ? "profileTab" : "designTab");
    button.setAttribute("aria-selected", String(name === view));
    button.tabIndex = name === view ? 0 : -1;
  }
  $("previous").hidden = !design;
  $("profileSave").hidden = design;
  $("profileSaveStatus").hidden = design;
  $("next").disabled = design;
  if (design) renderRecordingWorkspace();
  else renderAIPanel();
}

function circleSymbol(state) {
  const shape =
    state === "recording"
      ? '<rect class="recording-solid" x="7" y="7" width="10" height="10"/>'
      : state === "done"
        ? '<path d="m7 12 3 3 7-7"/>'
        : '<circle cx="12" cy="12" r="5"/>';
  return (
    '<svg class="design-action-icon ' +
    (state === "recording" ? "recording-status-icon" : "") +
    '" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="' +
    "10.5" +
    '"/>' +
    shape +
    "</svg>"
  );
}

const recordingGuideSteps = [
  "Paste a URL into the address bar and press Enter, before or after clicking Record.",
  "Click Record to begin recording.",
  "Sign in to the target page if required.",
  "Perform the actions you want to capture.",
  "Use + to open pages and switch between tabs while recording continues.",
  "Click Stop to finish. A numbered recording is added to the list.",
];

function recordingGuideMarkup() {
  return (
    '<div class="recording-guide"><h3>Recording Guide</h3>' +
    recordingGuideSteps
      .map((step, index) => `<p>Step ${index + 1} ${escapeHTML(step)}</p>`)
      .join("") +
    "</div>"
  );
}

function browserGuideHTML(showGuide = true) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;padding:24px;background:#fff;color:#101416;font:16px/24px 'Bosch Sans Global','Segoe UI',Arial,sans-serif}.recording-guide h3{font-size:16px;line-height:24px;margin:0 0 32px;font-weight:700}.recording-guide p{margin:0 0 16px}</style></head><body>${showGuide ? recordingGuideMarkup() : ""}<\/body><\/html>`;
}

function ensureRecordingLayout() {
  const state = recordingSession();
  if (!state.workspaceElement) {
    const template = document.getElementById("recordingLayoutTemplate");
    const layout = template.content.firstElementChild.cloneNode(true);
    layout.dataset.flow = activeFlowKey;
    state.workspaceElement = layout;
    $("designPanel").appendChild(layout);
  }
  for (const layout of $("designPanel").children) {
    if (!layout.classList.contains("recording-layout")) continue;
    const active = layout === state.workspaceElement;
    if (!active && !layout.hidden) {
      for (const element of layout.querySelectorAll("[id]")) {
        element.dataset.workspaceId = element.id;
        element.id += "--" + layout.dataset.flow;
      }
    }
    if (active) {
      for (const element of layout.querySelectorAll("[data-workspace-id]")) {
        element.id = element.dataset.workspaceId;
        delete element.dataset.workspaceId;
      }
    }
    layout.hidden = !active;
  }
  state.workspaceElement.classList.toggle(
    "is-recording",
    state.stage === "recording",
  );
  $("drawer").classList.toggle("recording-open", state.stage === "recording");
  return state.workspaceElement;
}

function createBrowserSurface(state) {
  const browser = state.workspaceElement.querySelector(".recording-browser");
  state.browserElement = browser;
  return browser;
}

function mountBrowserSurface() {
  const state = recordingSession(),
    layout = state.workspaceElement,
    browser = state.browserElement || createBrowserSurface(state);
  if (!layout.classList.contains("is-test")) {
    if (browser.parentElement !== layout) {
      layout.appendChild(browser);
    }
    browser.hidden = false;
  } else {
    const slot = layout.querySelector(".test-tab-browser-slot");
    if (slot && browser.parentElement !== slot) slot.appendChild(browser);
    browser.hidden = false;
  }
  for (const page of state.browserTabs)
    if (!page.frame) {
      const frame = document.createElement("iframe");
      frame.className = "recording-frame";
      frame.dataset.browserPage = page.id;
      frame.setAttribute("sandbox", "allow-scripts allow-forms");
      page.frame = frame;
      $("browserFrames").appendChild(frame);
      loadRecordingFrame(page);
    }
  $("recordingAddress").oninput = (e) => {
    e.target.setCustomValidity("");
    activeBrowserPage().draftURL = e.target.value;
  };
  $("recordingAddress").onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      openRecordingURL();
    }
  };
  $("recordingBack").onclick = () => moveRecordingHistory(-1);
  $("recordingForward").onclick = () => moveRecordingHistory(1);
  $("recordingReload").onclick = () => loadRecordingFrame();
  $("newBrowserPage").onclick = addBrowserPage;
  updateBrowserChrome();
  bindAIDock();
}

function browserPageLabel(page) {
  if (!page.url) return "New tab";
  if (page.url.startsWith("local://procurement/"))
    return page.route[0].toUpperCase() + page.route.slice(1);
  try {
    return new URL(page.url).hostname;
  } catch {
    return page.url;
  }
}

function updateBrowserChrome() {
  const state = recordingSession(),
    page = syncBrowserSession(),
    browser = state.browserElement;
  if (!browser || !browser.isConnected || browser.hidden) return;
  const tabs = browser.querySelector("#browserPageTabs");
  tabs.hidden = state.browserTabs.length < 2;
  const tabSignature = state.browserTabs
    .map(
      (tab, index) =>
        `${tab.id}:${tab.nativeId || ""}:${browserPageLabel(tab)}:${tab.id === page.id ? 1 : 0}`,
    )
    .join("|");
  if (tabs.dataset.signature !== tabSignature) {
    tabs.innerHTML = state.browserTabs
      .map(
        (tab, index) =>
          `<div class="browser-page-tab" role="presentation"><button role="tab" data-browser-tab="${tab.id}" aria-label="Browser page ${index + 1}: ${escapeHTML(browserPageLabel(tab))}" aria-selected="${tab.id === page.id}" tabindex="${tab.id === page.id ? 0 : -1}">${escapeHTML(browserPageLabel(tab))}</button><button class="browser-page-close" data-browser-close="${tab.id}" aria-label="Close browser page ${index + 1}" title="Close page">${designIcon("close")}</button></div>`,
      )
      .join("");
    tabs.dataset.signature = tabSignature;
  }
  tabs.onclick = (e) => {
    const close = e.target.closest("[data-browser-close]"),
      tab = e.target.closest("[data-browser-tab]");
    if (close) closeBrowserPage(close.dataset.browserClose);
    else if (tab) switchBrowserPage(tab.dataset.browserTab);
  };
  tabs.onkeydown = (e) => {
    const tab = e.target.closest("[data-browser-tab]");
    if (!tab || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key))
      return;
    e.preventDefault();
    const index = state.browserTabs.findIndex(
        (p) => p.id === tab.dataset.browserTab,
      ),
      next =
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? state.browserTabs.length - 1
            : (index +
                (e.key === "ArrowRight" ? 1 : -1) +
                state.browserTabs.length) %
              state.browserTabs.length;
    switchBrowserPage(state.browserTabs[next].id);
    tabs
      .querySelector(`[data-browser-tab="${state.activeBrowserTab}"]`)
      ?.focus();
  };
  for (const tab of state.browserTabs) {
    if (!tab.frame) continue;
    const active = tab.id === page.id;
    tab.frame.hidden = !active;
    tab.frame.id = active ? "recordingFrame" : "recordingFrame-" + tab.id;
    tab.frame.title = active
      ? "Recorded browser"
      : "Browser page " + browserPageLabel(tab);
  }
  const address = $("recordingAddress");
  if (
    address &&
    address.value !== page.draftURL &&
    document.activeElement !== address
  )
    address.value = page.draftURL;
  $("recordingBack").disabled = page.historyIndex <= 0;
  $("recordingForward").disabled = page.historyIndex >= page.history.length - 1;
  $("recordingReload").disabled = !page.url;
  const host = $("captureControlHost"),
    controlState = `${state.stage}:${!!state.pending?.finishing}:${!!state.groupPreparing}`;
  if (host.dataset.controlState !== controlState) {
    host.replaceChildren();
    host.dataset.controlState = controlState;
  }
  $("captureSurface").classList.toggle(
    "recording",
    state.stage === "recording",
  );
  updateRecordingActionButton();
  $("profileTab").disabled = state.stage === "recording";
  $("previous").disabled = state.stage === "recording";
}

function syncSelectAll() {
  const state = recordingSession(),
    all = $("recordingAll");
  if (!all) return;
  const total = state.items.length,
    checked = state.items.filter((item) => item.checked).length;
  all.checked = total > 0 && checked === total;
  all.indeterminate = checked > 0 && checked < total;
}

function bindRecordingList() {
  const state = recordingSession();
  renderRecordingItems();
  $("recordingAll").onchange = (e) => {
    state.allExplicit = e.target.checked;
    state.items.forEach((item) => (item.checked = e.target.checked));
    renderRecordingItems();
    syncSelectAll();
  };
  updateRecordingActionButton();
  $("summarizeRecordings").onclick = summarizeRecordings;
}

function renderRecordingWorkspace() {
  const state = recordingSession(),
    focused = currentAssistantItem();
  if (state.view === "analysis" && focused?.analyzed) {
    renderSummaryWorkspace();
    return;
  }
  const layout = ensureRecordingLayout(),
    results = layout.querySelector(".recording-results");
  layout.classList.remove("is-test");
  const testShell = layout.querySelector(".test-tab-shell");
  if (testShell) testShell.hidden = true;
  if (results) {
    results.hidden = true;
    results
      .querySelector('[id="aiToggle"]')
      ?.setAttribute("id", "analysisAIToggle");
    results.querySelectorAll("video").forEach((video) => video.pause());
  }
  if (state.browserElement) {
    state.browserElement.hidden = false;
    state.browserElement
      .querySelector('[id="browserAIToggle"]')
      ?.setAttribute("id", "aiToggle");
  }
  mountBrowserSurface();
  syncFloatingAIDock(state.browserElement);
  bindRecordingList();
  bindWorkspaceResize();
  renderAIPanel();
}

function renderRecordingItems() {
  const state = recordingSession();
  if (!$("recordingItems")) return;
  $("recordingItems").innerHTML = state.items
    .map(
      (item) =>
        `
      <div class="recording-row ${state.focused === item.id ? "current" : ""}">
        <input 
          type="checkbox" 
          class="recording-check" 
          data-recording-check="${item.id}" 
          aria-label="Select ${escapeHTML(item.name)}" 
          ${item.checked ? "checked" : ""}
        >
        <button class="recording-row-name" data-recording-open="${item.id}">${escapeHTML(item.name)}</button>
        ${item.summary ? '<span class="recording-badge merged">Refined</span>' : item.recorded ? '<span class="recording-badge recorded">Record</span>' : ""}
        <button 
          class="icon-button recording-delete" 
          data-recording-delete="${item.id}" 
          aria-label="Delete ${escapeHTML(item.name)}" 
          title="Delete" 
          ${state.stage === "recording" ? "disabled" : ""}
        >
          ${recordingDeleteIcon}
        </button>
      </div>`,
    )
    .join("");
  $("recordingItems").onchange = (e) => {
    const id = e.target.dataset.recordingCheck;
    if (!id) return;
    const item = state.items.find((item) => item.id === id);
    if (item) item.checked = e.target.checked;
    state.allExplicit = false;
    syncSelectAll();
    updateSummaryState();
  };
  $("recordingItems").onclick = (e) => {
    const remove = e.target.closest("[data-recording-delete]");
    if (remove) {
      deleteRecording(remove.dataset.recordingDelete);
      return;
    }
    const id = e.target.closest("[data-recording-open]")?.dataset.recordingOpen;
    if (!id || state.stage === "recording") return;
    const item = state.items.find((item) => item.id === id);
    if (!item) return;
    state.focused = id;
    state.view = "analysis";
    renderRecordingWorkspace();
  };
  syncSelectAll();
  updateSummaryState();
}

function updateRecordingActionButton() {
  const button = $("prepareRecording"),
    state = recordingSession();
  if (!button) return;
  const recording = state.stage === "recording";
  button.textContent = recording ? "Stop" : "Record";
  button.setAttribute("aria-label", recording ? "Stop recording" : "Record");
  button.disabled = !!state.pending?.finishing || !!state.groupPreparing;
  button.onclick = recording ? finishBrowserRecording : prepareRecording;
}

function updateSummaryState() {
  const state = recordingSession(),
    button = $("summarizeRecordings");
  if (button) {
    const checkedAnalyzed = state.items.filter(
      (item) => item.checked && item.analyzed,
    );
    button.disabled =
      state.stage === "recording" ||
      state.stage === "preparing" ||
      checkedAnalyzed.length < 2 ||
      state.items.some((item) => item.checked && !item.analyzed);
  }
}

async function prepareRecording() {
  const state = recordingSession();
  if (state.stage === "recording") return;
  if (typeof resetRecordingForNewSession === "function")
    await resetRecordingForNewSession();
  const page = syncBrowserSession();
  if (page.draftURL.trim() && page.draftURL !== page.url) {
    const url = validatedRecordingURL(page.draftURL);
    if (!url) {
      $("recordingAddress")?.setCustomValidity("Enter a valid URL.");
      $("recordingAddress")?.reportValidity();
      return;
    }
    await navigateRecordingBrowser(url);
  }
  state.hasStartedRecording = true;
  state.pending = null;
  state.focused = null;
  state.view = "browser";
  startBrowserRecording();
  if (!page.url) $("recordingAddress").focus();
}

function openRecordingURL() {
  const address = $("recordingAddress"),
    url = validatedRecordingURL(address.value);
  if (!url) {
    address.setCustomValidity("Enter a valid URL.");
    address.reportValidity();
    return;
  }
  navigateRecordingBrowser(url);
}

function startBrowserRecording() {
  const state = recordingSession();
  if (state.stage === "recording") return;
  const page = activeBrowserPage();
  if (!page.url && validatedRecordingURL(page.draftURL))
    navigateRecordingBrowser(page.draftURL);
  syncBrowserSession();
  if (!state.pending?.reRecordTarget)
    state.pending = {
      url: state.url,
      route: state.route,
      actions: [],
      checked: false,
      analyzed: false,
      resultTab: "Process",
      startedAt: Date.now(),
    };
  state.stage = "recording";
  state.view = "browser";
  renderRecordingWorkspace();
  startRecordingMedia(state);
  if (state.url && !state.pending.reRecordTarget)
    captureBrowserAction({ type: "navigate", url: state.url });
}

function validatedRecordingURL(value) {
  const input = String(value || "").trim();
  if (/^local:\/\/procurement\/(suppliers|draft|receipts)$/.test(input))
    return input;
  try {
    const parsed = new URL(input);
    if (["http:", "https:"].includes(parsed.protocol) && parsed.hostname)
      return parsed.href;
  } catch {}
  return null;
}

async function finishBrowserRecording() {
  const state = recordingSession();
  if (state.stage !== "recording" || !state.pending || state.pending.finishing)
    return;
  const pending = state.pending;
  pending.finishing = true;
  updateBrowserChrome();
  pending.media = await stopRecordingMedia(state);
  if (state.pending !== pending) return;
  if (pending.reRecordTarget) {
    finishNodeRecording(state);
    updateBrowserChrome();
    return;
  }
  const item = pending,
    number = ++recordingSequence;
  item.id = "recording-" + Date.now().toString(36) + "-" + number;
  item.name = "ZJ TEST " + number;
  item.url = state.url;
  item.route = state.route;
  item.pages = state.browserTabs.map((page) => ({
    id: page.id,
    url: page.url,
  }));
  delete item.finishing;
  state.items.push(item);
  state.focused = item.id;
  state.pending = null;
  state.stage = "done";
  state.view = "browser";
  state.allExplicit = false;
  renderRecordingWorkspace();
  // Reference analysis remains a local demonstration, separate from the recorded media.
  setTimeout(() => {
    if (!state.items.includes(item)) return;
    item.analyzed = true;
    item.steps = [...referenceOperation];
    if (drawerView === "Design" && state === recordingSession()) {
      if (state.view === "analysis" && state.focused === item.id)
        renderRecordingWorkspace();
      else {
        updateSummaryState();
        renderAIPanel();
      }
    }
  }, 500);
}

function updateCaptureControl() {
  updateBrowserChrome();
}

function captureBrowserAction(action) {
  const state = recordingSession();
  if (state.stage === "recording" && state.pending) {
    state.pending.actions.push({
      ...action,
      tabId: action.tabId || state.activeBrowserTab,
      elapsed: Date.now() - state.pending.startedAt,
    });
    requestRecordingSnapshot();
  }
}

function navigateRecordingBrowser(
  url,
  addHistory = true,
  page = activeBrowserPage(),
) {
  const next = validatedRecordingURL(url);
  if (!next) return;
  const state = recordingSession();
  page.url = next;
  page.draftURL = next;
  page.route =
    next.match(/^local:\/\/procurement\/(suppliers|draft|receipts)$/)?.[1] ||
    page.route;
  if (addHistory) {
    page.history = page.history.slice(0, page.historyIndex + 1);
    page.history.push(next);
    page.historyIndex = page.history.length - 1;
  }
  if (state.stage === "guide") state.stage = "ready";
  syncBrowserSession();
  captureBrowserAction({ type: "navigate", url: next, tabId: page.id });
  if (!state.browserElement || !state.browserElement.isConnected) {
    state.view = "browser";
    renderRecordingWorkspace();
  } else {
    loadRecordingFrame(page);
    if (state.view !== "analysis") updateBrowserChrome();
  }
}

function moveRecordingHistory(direction) {
  const page = activeBrowserPage(),
    index = page.historyIndex + direction;
  if (index < 0 || index >= page.history.length) return;
  page.historyIndex = index;
  if (!page.history[index]) {
    page.url = "";
    page.draftURL = "";
    syncBrowserSession();
    loadRecordingFrame(page);
    updateBrowserChrome();
  } else navigateRecordingBrowser(page.history[index], false);
}

function loadRecordingFrame(page = activeBrowserPage()) {
  const frame = page.frame;
  if (!frame) return;
  if (!page.url || page.url.startsWith("local://procurement/")) {
    frame.removeAttribute("src");
    const html = page.url
      ? embeddedBrowserHTML(page.route)
      : browserGuideHTML(page.showGuide);
    frame.srcdoc = html.replace(
      "<\/body>",
      "<script>(" +
        embeddedSnapshotBridge.toString() +
        ")();<\/script><\/body>",
    );
  } else {
    frame.removeAttribute("srcdoc");
    frame.src = page.url;
  }
  frame.onload = () => {
    if (page.id === recordingSession().activeBrowserTab)
      requestRecordingSnapshot();
  };
}

function addBrowserPage() {
  const state = recordingSession(),
    page = createBrowserPage(recordingTestURL, false);
  state.browserTabs.push(page);
  state.activeBrowserTab = page.id;
  const frame = document.createElement("iframe");
  frame.className = "recording-frame";
  frame.dataset.browserPage = page.id;
  frame.setAttribute("sandbox", "allow-scripts allow-forms");
  page.frame = frame;
  $("browserFrames").appendChild(frame);
  loadRecordingFrame(page);
  updateBrowserChrome();
  captureBrowserAction({ type: "tab-open", url: "", tabId: page.id });
  $("recordingAddress").focus();
}

function switchBrowserPage(id) {
  const state = recordingSession();
  if (
    !state.browserTabs.some((page) => page.id === id) ||
    id === state.activeBrowserTab
  )
    return;
  state.activeBrowserTab = id;
  updateBrowserChrome();
  captureBrowserAction({ type: "tab-switch", url: state.url, tabId: id });
  requestRecordingSnapshot();
}

function closeBrowserPage(id) {
  const state = recordingSession(),
    index = state.browserTabs.findIndex((page) => page.id === id);
  if (index < 0) return;
  if (state.browserTabs.length === 1) {
    const page = state.browserTabs[0];
    page.url = recordingTestURL;
    page.draftURL = recordingTestURL;
    page.showGuide = false;
    page.history = [recordingTestURL];
    page.historyIndex = 0;
    loadRecordingFrame(page);
  } else {
    state.browserTabs[index].frame.remove();
    state.browserTabs.splice(index, 1);
    if (state.activeBrowserTab === id)
      state.activeBrowserTab =
        state.browserTabs[Math.min(index, state.browserTabs.length - 1)].id;
  }
  updateBrowserChrome();
  captureBrowserAction({ type: "tab-close", tabId: id });
  requestRecordingSnapshot();
}

function offsetFlowSteps(steps, offset) {
  return steps.map((step) => {
    const clone = { ...step };
    if (clone.page?.index !== undefined)
      clone.page = { ...clone.page, index: clone.page.index + offset };
    if (
      (clone.kind === "switchTab" || clone.kind === "closeTab") &&
      typeof clone.index === "number"
    )
      clone.index += offset;
    if (clone.kind === "group" && Array.isArray(clone.steps))
      clone.steps = offsetFlowSteps(clone.steps, offset);
    return clone;
  });
}

function maxPageIndex(steps) {
  let max = 0;
  function visit(list) {
    for (const step of list) {
      if (step.page?.index !== undefined) max = Math.max(max, step.page.index);
      if (
        (step.kind === "switchTab" || step.kind === "closeTab") &&
        typeof step.index === "number"
      )
        max = Math.max(max, step.index);
      if (step.kind === "group" && Array.isArray(step.steps)) visit(step.steps);
    }
  }
  visit(steps);
  return max;
}

function minimalElementRef(label) {
  const text = String(label || "");
  return {
    observed: {
      tag: "div",
      attributes: {},
      text,
      rect: { x: 0, y: 0, width: 100, height: 24 },
      scroll: { x: 0, y: 0 },
      viewport: { width: 1280, height: 720 },
      dpr: 1,
      recordedAt: Date.now(),
    },
    candidates: [{ kind: "text", value: text, score: 0, source: "record" }],
    fingerprint: { tag: "div", attrs: {}, stableHash: "" },
    description: text,
  };
}

function stepDetailToFlowStep(detail, stepId, pageIndex) {
  const base = {
    id: stepId,
    page: pageIndex > 0 ? { index: pageIndex } : undefined,
  };
  const type = detail.type || "action";
  const url = detail.url || "";
  if (type === "open" || type === "navigate" || type === "打开页面")
    return { ...base, kind: "navigate", url: url || "about:blank" };
  if (type === "input" || type === "填写" || type === "输入")
    return {
      ...base,
      kind: "input",
      target: minimalElementRef(detail.target),
      value: detail.value || "",
      clear: true,
    };
  if (type === "select" || type === "选择")
    return {
      ...base,
      kind: "select",
      target: minimalElementRef(detail.target),
      value: detail.value || "",
    };
  return { ...base, kind: "click", target: minimalElementRef(detail.target) };
}

async function buildMergedFlow(chosen, combined) {
  const mergedSteps = [];
  let pageOffset = 0;
  for (const item of chosen) {
    let steps = [];
    if (item.flowFile) {
      try {
        const flow = await F.flow.load(item.flowFile);
        steps = flow?.steps || [];
      } catch (err) {
        console.error("[merge] load flow failed:", err);
      }
    }
    if (!steps.length && item.stepDetails) {
      steps = item.stepDetails.map((detail, i) =>
        stepDetailToFlowStep(
          detail,
          `${item.id}-step-${i}`,
          (detail.tab || 1) - 1,
        ),
      );
    }
    if (steps.length) {
      mergedSteps.push(...offsetFlowSteps(steps, pageOffset));
      pageOffset += maxPageIndex(steps) + 1;
    }
  }
  if (!mergedSteps.length)
    mergedSteps.push({
      id: "step-0",
      kind: "navigate",
      url: combined.url || "about:blank",
    });
  return {
    schemaVersion: 1,
    id: combined.id,
    title: combined.name,
    version: 1,
    createdAt: new Date().toISOString(),
    meta: {
      env: {
        startUrl: combined.url || "about:blank",
        viewport: { width: 1280, height: 720 },
        dpr: 1,
      },
      recorder: { name: "FlowLink", version: "1.0.0" },
    },
    variables: [],
    steps: mergedSteps,
  };
}

function summarizeRecordings() {
  const state = recordingSession();
  const chosen = state.items.filter((item) => item.checked && item.analyzed);
  if (
    chosen.length < 2 ||
    state.items.some((item) => item.checked && !item.analyzed) ||
    state.stage === "recording" ||
    state.stage === "preparing"
  )
    return;
  $("summaryDialog").showModal();
}

async function confirmRecordingSummary() {
  const state = recordingSession(),
    chosen = state.items.filter((item) => item.checked && item.analyzed);
  if (chosen.length < 2) {
    $("summaryDialog").close();
    return;
  }
  const references = chosen
    .flatMap((item) => ensureReferenceFiles(item))
    .map((file) => ({ ...file, id: "reference-" + ++referenceSequence }));
  const combinedSteps = chosen.flatMap((item) => item.steps || []);
  const combinedDetails = chosen.flatMap((item) => item.stepDetails || []);
  const combinedScreenshots = chosen
    .flatMap((item) => item.media?.screenshots || [])
    .slice(0, combinedSteps.length);
  const combinedGroups = [];
  let offset = 0;
  let groupSeq = 0;
  for (const item of chosen) {
    const groups = ensureProcessGroups(item);
    for (const g of groups) {
      combinedGroups.push({
        id: "group-" + ++processGroupSequence,
        name: g.name,
        count: g.count,
        start: offset,
        number: String(++groupSeq).padStart(2, "0"),
        tab: g.tab,
        url: g.url,
      });
      offset += g.count;
    }
  }
  const combined = {
    id: "recording-" + Date.now().toString(36) + "-" + ++recordingSequence,
    name: "Merged " + recordingSequence,
    url: chosen[chosen.length - 1].url,
    route: chosen[chosen.length - 1].route,
    checked: false,
    summary: true,
    analyzed: true,
    recorded: false,
    references,
    resultTab: "Process",
    media: {
      videoURL: chosen[chosen.length - 1].media?.videoURL || "",
      screenshots: combinedScreenshots,
    },
    steps: combinedSteps,
    stepDetails: combinedDetails,
    processGroups: combinedGroups,
    sourceIds: chosen.flatMap((item) => item.sourceIds || [item.id]),
  };
  try {
    const flow = await buildMergedFlow(chosen, combined);
    const recording = await F.recording.persistMerged({
      taskCode: currentFlow?.code || activeFlowKey,
      flow,
      name: combined.name,
    });
    combined.recordingId = recording.id;
    combined.flowFile = recording.flowFile;
    combined.artifactsDir = recording.artifactsDir;
    rebuildItemTestFlow(combined);
  } catch (err) {
    console.error("[merge] persist failed:", err);
  }
  const lastIndex = state.items.findIndex(
    (item) => item.id === chosen[chosen.length - 1].id,
  );
  state.items.splice(lastIndex + 1, 0, combined);
  state.items.forEach((item) => (item.checked = false));
  state.focused = combined.id;
  state.view = "analysis";
  state.stage = "done";
  state.allExplicit = false;
  $("summaryDialog").close();
  renderRecordingWorkspace();
  syncSelectAll();
  document.querySelector('[data-recording-open="' + combined.id + '"]').focus();
}

function renderSummaryWorkspace() {
  const state = recordingSession(),
    item = currentAssistantItem(),
    active = item.resultTab || "Process";
  state.view = "analysis";
  if (active === "Test" && state.testBrowserResetKey !== item.id) {
    state.testBrowserResetKey = item.id;
    if (typeof resetTestBrowser === "function") void resetTestBrowser(item);
  }
  if (active !== "Test") state.testBrowserResetKey = "";
  const layout = ensureRecordingLayout();
  layout.classList.toggle("is-test", active === "Test");
  const testShell = layout.querySelector(".test-tab-shell"),
    results = layout.querySelector(".recording-results"),
    tabs = layout.querySelector(".summary-tabs"),
    resultPanel = layout.querySelector("#summaryResultPanel");
  testShell.hidden = active !== "Test";
  if (active !== "Test" && state.browserElement) {
    state.browserElement.hidden = true;
    state.browserElement
      .querySelector('[id="aiToggle"]')
      ?.setAttribute("id", "browserAIToggle");
  }
  results.hidden = false;
  if (active === "Test") {
    testShell.prepend(tabs);
    const browserSlot = testShell.querySelector(".test-tab-browser-slot");
    if (state.browserElement) browserSlot.appendChild(state.browserElement);
    const body = testShell.querySelector(".test-tab-body");
    body.appendChild(results);
  } else {
    results.prepend(tabs);
    layout.appendChild(results);
  }
  tabs.querySelectorAll("[data-summary-tab]").forEach((button) => {
    const selected = button.dataset.summaryTab === active;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  resultPanel.className =
    "summary-result-content " +
    (active === "Reference"
      ? "reference-active"
      : active === "Process"
        ? "process-active"
        : active === "Metric"
          ? "metric-active"
          : "");
  resultPanel.setAttribute("aria-labelledby", summaryTabId(active));
  resultPanel.innerHTML = analysisResultMarkup(active);
  if (active === "Test" && state.browserElement) {
    state.browserElement.hidden = false;
    mountBrowserSurface();
  }
  $("profileTab").disabled = false;
  $("previous").disabled = false;
  syncFloatingAIDock(results);
  bindRecordingList();
  bindWorkspaceResize();
  renderAIPanel();
  bindStepEditor();
  bindProcessMap();
  bindReferenceFiles();
  bindMetricPreferences();
  bindScreenshotZoom();
  const runButton = $("runRecordingTest");
  if (runButton)
    runButton.onclick = () => {
      if (window.runFlowlinkTest) window.runFlowlinkTest(item);
    };
  const stopButton = $("stopRecordingTest");
  if (stopButton)
    stopButton.onclick = () => {
      if (window.stopFlowlinkTest) window.stopFlowlinkTest(item);
    };
  const tabButtons = tabs.querySelectorAll("[data-summary-tab]");
  tabButtons.forEach((button) => {
    button.onclick = () => {
      const nextTab = button.dataset.summaryTab;
      if (item.resultTab === "Test" || nextTab === "Test")
        resetTestExecutionStatus(item);
      item.resultTab = nextTab;
      renderSummaryWorkspace();
      $(summaryTabId(item.resultTab)).focus();
    };
    button.onkeydown = (e) => {
      let index = summaryTabs.indexOf(button.dataset.summaryTab);
      if (e.key === "ArrowRight") index = (index + 1) % summaryTabs.length;
      else if (e.key === "ArrowLeft")
        index = (index + summaryTabs.length - 1) % summaryTabs.length;
      else if (e.key === "Home") index = 0;
      else if (e.key === "End") index = summaryTabs.length - 1;
      else return;
      e.preventDefault();
      const nextTab = summaryTabs[index];
      if (item.resultTab === "Test" || nextTab === "Test")
        resetTestExecutionStatus(item);
      item.resultTab = nextTab;
      renderSummaryWorkspace();
      $(summaryTabId(item.resultTab)).focus();
    };
  });
}

async function deleteRecording(id) {
  const state = recordingSession();
  if (state.stage === "recording" || state.stage === "preparing") return;
  const index = state.items.findIndex((item) => item.id === id);
  if (index < 0) return;
  if (
    !(await confirmWorkspaceAction(
      `Delete recording “${state.items[index].name}”?`,
    ))
  )
    return;
  const wasFocused = state.focused === id;
  state.items.splice(index, 1);
  state.allExplicit = false;
  if (!state.items.length) state.aiOpen = false;
  if (wasFocused) {
    state.view = state.items.length ? "analysis" : "browser";
    const next = state.items[Math.min(index, state.items.length - 1)];
    state.focused = next?.id || null;
    state.stage = next ? "done" : "guide";
    if (next) {
      state.url = next.url;
      state.route = next.route;
      state.history = [next.url];
      state.historyIndex = 0;
    }
  }
  renderRecordingWorkspace();
  const next = state.items[Math.min(index, state.items.length - 1)];
  if (next)
    document.querySelector('[data-recording-delete="' + next.id + '"]').focus();
  else $("prepareRecording").focus();
}

$("summaryCancel").onclick = () => {
  $("summaryDialog").close();
  $("summarizeRecordings").focus();
};
$("summaryClose").onclick = $("summaryCancel").onclick;
$("summaryDialog").addEventListener("cancel", (e) => {
  e.preventDefault();
  $("summaryCancel").click();
});
$("summaryYes").onclick = confirmRecordingSummary;
window.addEventListener("message", (e) => {
  const state = recordingSession(),
    page = state.browserTabs.find(
      (tab) => tab.frame?.contentWindow === e.source,
    );
  if (!page) return;
  if (e.data?.type === "flowlink-snapshot") {
    if (page.id === state.activeBrowserTab) receiveRecordingSnapshot(e.data);
    return;
  }
  if (
    e.data?.type === "flowlink-route" &&
    ["suppliers", "draft", "receipts"].includes(e.data.route)
  )
    navigateRecordingBrowser("local://procurement/" + e.data.route, true, page);
  if (e.data?.type === "flowlink-recording-complete") finishBrowserRecording();
  if (e.data?.type === "flowlink-click")
    captureBrowserAction({
      type: "click",
      target: String(e.data.target),
      tabId: page.id,
    });
  if (e.data?.type === "flowlink-input")
    captureBrowserAction({
      type: "input",
      target: String(e.data.target),
      value: String(e.data.value),
      tabId: page.id,
    });
});

$("profileTab").onclick = () => showDrawerTab("Profile");
$("designTab").onclick = () => showDrawerTab("Design");
$("previous").onclick = () => {
  showDrawerTab("Profile");
  $("profileTab").focus();
};
$("next").onclick = () => {
  showDrawerTab("Design");
  $("designTab").focus();
};
for (const id of ["profileTab", "designTab"])
  $(id).onkeydown = (e) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const target =
      e.key === "Home"
        ? "Profile"
        : e.key === "End"
          ? "Design"
          : drawerView === "Profile"
            ? "Design"
            : "Profile";
    showDrawerTab(target);
    $(target === "Profile" ? "profileTab" : "designTab").focus();
  };

// Local dialogue and node capture prototype; no external AI requests are made.
function currentAssistantItem() {
  const s = recordingSession();
  return s.items.find((item) => item.id === s.focused);
}

function currentAssistantContext() {
  const item = currentAssistantItem();
  return item?.analyzed ? item : recordingSession().guideAssistant;
}

function aiDockMarkup() {
  return `<button class="ai-dock" id="aiToggle" aria-label="AI" aria-expanded="${!!recordingSession().aiOpen}" aria-controls="recordingAssistant">Ai<small aria-hidden="true">✦</small></button>`;
}

function bindAIDock() {
  const toggle = $("aiToggle");
  if (toggle)
    toggle.onclick = () => {
      const state = recordingSession();
      state.aiOpen = !state.aiOpen;
      renderAIPanel();
      if (state.aiOpen) $("assistantInput").focus();
    };
}

function syncFloatingAIDock(target) {
  const existing = document.querySelector(".ai-dock");
  document.querySelectorAll(".ai-dock").forEach((dock) => {
    if (dock !== existing) dock.remove();
  });
  if (!target) {
    existing?.remove();
    return;
  }
  if (existing) {
    if (existing.parentElement !== target) target.appendChild(existing);
    bindAIDock();
    return;
  }
  target.insertAdjacentHTML("beforeend", aiDockMarkup());
  bindAIDock();
}

function ensureAssistantData(item) {
  item.steps ??= [...referenceOperation];
  item.chat ??= [];
  item.chatDraft ??= "";
}

function renderAIPanel() {
  const state = recordingSession(),
    recording = currentAssistantItem(),
    item = currentAssistantContext(),
    open = drawerView === "Design" && state.aiOpen;
  $("drawer").classList.toggle("ai-open", !!open);
  $("recordingAssistant").hidden = !open;
  $("aiToggle")?.setAttribute("aria-expanded", String(!!open));
  if (!open) return;
  ensureAssistantData(item);
  bindAssistantResize();
  $("assistantFileName").textContent = "AI 助手";
  $("assistantClose").onclick = () => {
    state.aiOpen = false;
    renderAIPanel();
    $("aiToggle")?.focus();
  };
  const selectedGroup =
    recording?.analyzed && state.view === "analysis"
      ? ensureProcessGroups(recording).find(
          (group) => group.id === recording.selectedGroup,
        )
      : null;
  $("recordingAssistant").classList.toggle(
    "has-group-context",
    !!selectedGroup,
  );
  const aiOptionsMarkup = `<div class="assistant-options"><button type="button" class="assistant-option" data-ai-option="merge" aria-label="Merge selected recordings">Merge selected recordings</button><button type="button" class="assistant-option" data-ai-option="generate" aria-label="Generate flow from description">Generate flow from description</button><button type="button" class="assistant-option" data-ai-option="optimize" aria-label="Optimize current flow">Optimize current flow</button></div>`;
  $("assistantSteps").innerHTML = selectedGroup
    ? `<div class="assistant-group-name">${selectedGroup.number} ${escapeHTML(selectedGroup.name)}</div><div class="assistant-group-options"><button type="button" id="assistantGroupRecord"><span>A</span><span>Re-record</span></button><button type="button" id="assistantGroupAdd" aria-expanded="false"><span>B</span><span>Add node</span></button><div id="assistantGroupInsert" class="assistant-group-insert" hidden><button type="button" data-ai-group-insert="before">Before this node</button><button type="button" data-ai-group-insert="after">After this node</button></div></div>`
    : aiOptionsMarkup +
      item.steps
        .map(
          (step, index) =>
            `<div class="assistant-step"><span class="assistant-step-number">Step ${index + 1}:</span><span>${escapeHTML(step)}</span></div>`,
        )
        .join("");
  $("assistantSteps").onclick = (e) => {
    const option = e.target.closest("[data-ai-option]");
    if (option) {
      e.preventDefault();
      invokeAIMerge(option.dataset.aiOption);
      return;
    }
    if (selectedGroup) {
      const button = e.target.closest("[data-ai-group-insert]");
      if (button)
        beginGroupRecording(
          recording,
          selectedGroup.id,
          button.dataset.aiGroupInsert,
        );
    }
  };
  if (selectedGroup) {
    $("assistantGroupRecord").onclick = () =>
      beginGroupRecording(recording, selectedGroup.id, "replace");
    $("assistantGroupAdd").onclick = () => {
      const menu = $("assistantGroupInsert");
      menu.hidden = !menu.hidden;
      $("assistantGroupAdd").setAttribute(
        "aria-expanded",
        String(!menu.hidden),
      );
    };
  }

  $("assistantChat").innerHTML = item.chat
    .map(
      (message) =>
        `<p class="assistant-message ${message.role}" aria-label="${message.role === "user" ? "User" : "AI"}">${escapeHTML(message.text)}</p>`,
    )
    .join("");
  $("assistantChat").scrollTop = $("assistantChat").scrollHeight;
  $("assistantInput").value = item.chatDraft;
  $("assistantInput").disabled = false;
  $("assistantSend").disabled = !item.chatDraft.trim();
  $("assistantSend").onclick = submitAssistantMessage;
  $("assistantInput").oninput = (e) => {
    item.chatDraft = e.target.value;
    $("assistantSend").disabled = !item.chatDraft.trim();
  };
  $("assistantInput").onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submitAssistantMessage();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      state.aiOpen = false;
      renderAIPanel();
      $("aiToggle")?.focus();
    }
  };
  $("recordingAssistant").onkeydown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      state.aiOpen = false;
      renderAIPanel();
      $("aiToggle")?.focus();
    }
  };
}

function invokeAIMerge(option, prompt) {
  const state = recordingSession(),
    recording = currentAssistantItem(),
    item = currentAssistantContext();
  ensureAssistantData(item);
  const optionLabels = {
    merge: "Merge selected recordings",
    generate: "Generate flow from description",
    optimize: "Optimize current flow",
    input: prompt || "User request",
  };
  const userText = prompt || optionLabels[option] || option;
  item.chat.push({ role: "user", text: userText });
  item.chatDraft = "";

  const chosen = state.items.filter((entry) => entry.checked && entry.analyzed);

  if (option === "merge" && chosen.length >= 2) {
    item.chat.push({
      role: "assistant",
      text: "Merging selected recordings...",
    });
    renderAIPanel();
    confirmRecordingSummary();
    return;
  }

  if ((option === "merge" || option === "optimize") && recording?.analyzed) {
    item.chat.push({
      role: "assistant",
      text: "AI mock: processing current flow (merge path placeholder).",
    });
    renderAIPanel();
    return;
  }

  if (option === "generate" && prompt) {
    item.chat.push({
      role: "assistant",
      text: "AI mock: generating flow from description (placeholder).",
    });
    renderAIPanel();
    return;
  }

  item.chat.push({
    role: "assistant",
    text: "当前为本地交互示例，尚未连接 AI 服务。",
  });
  renderAIPanel();
  $("assistantInput")?.focus();
}

function requestedStep(text) {
  const m =
    text.match(
      /(?:步骤|节点|结点|step)\s*(?:第\s*)?([0-9零〇一二两三四五六七八九十]+)/i,
    ) ||
    text.match(
      /第\s*([0-9零〇一二两三四五六七八九十]+)\s*(?:步|个?节点|个?结点)/,
    );
  if (!m) return null;
  if (/^\d+$/.test(m[1])) return Number(m[1]) - 1;
  const digits = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  const parts = m[1].split("十");
  const n =
    parts.length === 2
      ? (parts[0] ? digits[parts[0]] : 1) * 10 +
        (parts[1] ? digits[parts[1]] : 0)
      : digits[m[1]];
  return Number.isFinite(n) ? n - 1 : null;
}

function submitAssistantMessage() {
  const item = currentAssistantContext();
  ensureAssistantData(item);
  const message = $("assistantInput").value.trim();
  if (!message) return;
  invokeAIMerge("input", message);
}

function beginNodeRecording(item, index) {
  const state = recordingSession();
  state.view = "browser";
  state.aiOpen = true;
  const page = activeBrowserPage();
  page.url = item.url;
  page.draftURL = item.url;
  page.route = item.route;
  page.history = [item.url];
  page.historyIndex = 0;
  state.pending = {
    reRecordTarget: item.id,
    nodeIndex: index,
    actions: [],
    startedAt: Date.now(),
  };
  state.stage = "ready";
  renderRecordingWorkspace();
  loadRecordingFrame(page);
  startBrowserRecording();
}

function capturedActionText(action) {
  if (action.type === "navigate") return action.url;
  if (action.type === "input") return `${action.target}: ${action.value}`;
  return "";
}

function finishNodeRecording(state) {
  const pending = state.pending,
    item = state.items.find((item) => item.id === pending.reRecordTarget);
  state.pending = null;
  state.stage = "done";
  if (!item) {
    state.focused = null;
    state.stage = "guide";
    renderRecordingWorkspace();
    return;
  }
  ensureAssistantData(item);
  if (pending.groupId) {
    finishGroupRecording(state, pending, item);
    return;
  }
  state.focused = item.id;
  item.nodeActions ??= {};
  if (pending.media) {
    const screenshots = item.media?.screenshots
      ? [...item.media.screenshots]
      : [];
    const newScreenshots = pending.media.screenshots || [];
    screenshots.splice(pending.nodeIndex, 1, ...newScreenshots);
    while (screenshots.length < item.steps.length) {
      screenshots.push({
        image: "",
        name: `Screenshot-${String(screenshots.length + 1).padStart(2, "0")}.png`,
      });
    }
    screenshots.splice(item.steps.length);
    screenshots.forEach((s, i) => {
      s.name = `Screenshot-${String(i + 1).padStart(2, "0")}.png`;
      if (!s.image) s.image = "";
    });
    item.media = { ...(item.media || {}), screenshots };
  }
  if (pending.actions.length) {
    item.nodeActions[pending.nodeIndex] = pending.actions.map((action) => ({
      ...action,
    }));
    item.steps[pending.nodeIndex] =
      pending.actions.map(capturedActionText).filter(Boolean).join(" → ") ||
      item.steps[pending.nodeIndex];
    const lastInput = [...pending.actions]
      .reverse()
      .find((action) => action.type === "input");
    if (lastInput && item.stepDetails?.[pending.nodeIndex]) {
      const detail = item.stepDetails[pending.nodeIndex];
      detail.type = "输入";
      detail.target = lastInput.target;
      detail.value = lastInput.value;
    }
    item.nodeUpdates = true;
    item.chat.push({
      role: "assistant",
      text: `步骤 ${pending.nodeIndex + 1} 已更新。`,
    });
  } else
    item.chat.push({
      role: "assistant",
      text: `步骤 ${pending.nodeIndex + 1} 未录制到操作，保留原内容。`,
    });
  item.resultTab = "Process";
  state.view = "analysis";
  renderRecordingWorkspace();
  $("assistantInput").focus();
}

function nativeUpdatedProcess(item) {
  return processMapMarkup(item);
}

// Editable fields follow the supplied Steps reference. Data remains local to its recording.
function ensureStepDetails(item) {
  ensureAssistantData(item);
  if (!item.stepDetails || item.stepDetails.length !== item.steps.length)
    item.stepDetails = item.steps.map((text, index) => ({
      type:
        index === 0
          ? "打开页面"
          : /^(在|填写)/.test(text)
            ? "输入"
            : text.startsWith("选择")
              ? "选择"
              : text.startsWith("上传")
                ? "上传"
                : "点击",
      target: index === 0 ? item.url : text.match(/【(.*?)】/)?.[1] || "",
      value: text.match(/\{(.*?)\}/)?.[0] || "",
      url: index === 0 ? item.url || "" : "",
      tab: 1,
      role: index === 2 ? "textbox" : "link",
    }));
}

let processGroupSequence = 0;
function ensureProcessGroups(item) {
  ensureAssistantData(item);
  if (!item.processGroups) {
    let start = 0;
    item.processGroups = leaveGroupSeed
      .map((seed) => {
        const count = Math.min(
            seed.steps.length,
            Math.max(0, item.steps.length - start),
          ),
          group = {
            id: "group-" + ++processGroupSequence,
            name: seed.name,
            count,
          };
        start += count;
        return group;
      })
      .filter((group) => group.count);
    if (start < item.steps.length)
      item.processGroups.push({
        id: "group-" + ++processGroupSequence,
        name: "后续操作",
        count: item.steps.length - start,
      });
  }
  let offset = 0;
  return item.processGroups.map((group, index) => {
    const view = {
      ...group,
      index,
      start: offset,
      number: String(index + 1).padStart(2, "0"),
      steps: item.steps.slice(offset, offset + group.count),
    };
    offset += group.count;
    return view;
  });
}

const genericGroupIcon =
  "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22%3E%3Crect x=%221%22 y=%221%22 width=%2214%22 height=%2214%22 rx=%222%22 fill=%22none%22 stroke=%22%23838B92%22 stroke-width=%221.5%22/%3E%3Cpath d=%22M4 8h8M8 4v8%22 stroke=%22%23838B92%22 stroke-width=%221.5%22/%3E%3C/svg%3E";
function groupFaviconUrl(url) {
  if (!url || url === "about:blank" || url.startsWith("local://"))
    return genericGroupIcon;
  try {
    const parsed = new URL(url);
    if (["http:", "https:"].includes(parsed.protocol) && parsed.hostname)
      return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(parsed.hostname)}&sz=32`;
  } catch {}
  return genericGroupIcon;
}

function buildProcessTabGroups(flowSteps, texts) {
  const groups = [];
  let currentTab = null,
    currentUrl = null,
    current = null;
  const urlsByTab = new Map();
  for (let index = 0; index < texts.length; index++) {
    const step = flowSteps[index] || {};
    const tab = (step.page?.index ?? 0) + 1;
    if ((step.kind === "navigate" || step.kind === "openTab") && step.url)
      urlsByTab.set(tab, step.url);
    const url = urlsByTab.get(tab) || "";
    const key = tab + "\n" + url;
    if (!current || tab !== currentTab || url !== currentUrl) {
      if (current && current.count) groups.push(current);
      currentTab = tab;
      currentUrl = url;
      current = {
        id: "group-" + ++processGroupSequence,
        name: url
          ? `Tab ${tab} · ${url.replace(/^https?:\/\//, "").replace(/\/$/, "")}`
          : `Tab ${tab}`,
        count: 0,
        tab,
        url,
      };
    }
    current.count++;
  }
  if (current && current.count) groups.push(current);
  return groups.length
    ? groups
    : [
        {
          id: "group-" + ++processGroupSequence,
          name: "Tab 1",
          count: texts.length,
          tab: 1,
        },
      ];
}

function buildTabGroupsForItem(item) {
  ensureStepDetails(item);
  const groups = [];
  let currentTab = null,
    currentUrl = null,
    current = null;
  const urlsByTab = new Map();
  item.steps.forEach((text, index) => {
    const detail = item.stepDetails[index] || {};
    let tab = Number(detail.tab) || 1;
    if (!tab && /^\[Tab (\d+)\]/.test(text))
      tab = Number(text.match(/^\[Tab (\d+)\]/)[1]);
    if (detail.url) urlsByTab.set(tab, detail.url);
    const url =
      urlsByTab.get(tab) ||
      detail.url ||
      item.recordingStartUrls?.[tab] ||
      item.url ||
      "";
    if (!current || tab !== currentTab || url !== currentUrl) {
      if (current && current.count) groups.push(current);
      currentTab = tab;
      currentUrl = url;
      current = {
        id: "group-" + ++processGroupSequence,
        name: url
          ? `Tab ${tab} · ${url.replace(/^https?:\/\//, "").replace(/\/$/, "")}`
          : `Tab ${tab}`,
        count: 0,
        tab,
        url,
      };
    }
    current.count++;
  });
  return groups.length
    ? groups
    : [
        {
          id: "group-" + ++processGroupSequence,
          name: "Tab 1",
          count: 0,
          tab: 1,
        },
      ];
}

function editableStepsMarkup(item) {
  if (!item) return "";
  ensureStepDetails(item);
  item.instructionExpanded ??= [];
  return `<div class="grouped-steps">${ensureProcessGroups(item)
    .map((group) => {
      const expanded = item.instructionExpanded.includes(group.id);
      return `<section class="steps-group" data-instruction-group="${group.id}"><div class="instruction-group-heading"><h3>${group.number} ${escapeHTML(group.name)}</h3><button class="instruction-expand" type="button" data-instruction-expand="${group.id}" aria-expanded="${expanded}"><span>${expanded ? "Collapse" : "Expand"}</span><svg class="design-action-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 9 7 7 7-7"/></svg></button></div>${group.steps
        .map((text, offset) => {
          const index = group.start + offset,
            detail = item.stepDetails[index],
            code = group.number + "-" + String(offset + 1).padStart(3, "0");
          return `<div class="instruction-step"><div class="instruction-row"><span class="step-row-number">${code}</span><span class="step-row-text">${escapeHTML(text)}</span></div><div class="step-detail-fields" data-group-details ${expanded ? "" : "hidden"}><label>操作内容<textarea data-step-field="text" data-step-index="${index}" aria-label="${code} 操作内容">${escapeHTML(text)}</textarea></label><div class="step-field-grid"><label>操作类型<input data-step-field="type" data-step-index="${index}" value="${escapeHTML(detail.type)}"></label><label>目标<input data-step-field="target" data-step-index="${index}" value="${escapeHTML(detail.target)}"></label><label>填写内容<input data-step-field="value" data-step-index="${index}" value="${escapeHTML(detail.value)}"></label></div></div></div>`;
        })
        .join("")}</section>`;
    })
    .join("")}</div>`;
}

function normalizeStepKind(type) {
  if (type === "open" || type === "navigate" || type === "打开页面")
    return "navigate";
  if (type === "input" || type === "填写" || type === "输入") return "input";
  if (type === "select" || type === "选择") return "select";
  if (type === "click") return "click";
  if (type === "key") return "key";
  if (type === "hover") return "hover";
  if (type === "scroll") return "scroll";
  if (type === "switchTab") return "switchTab";
  if (type === "openTab") return "openTab";
  if (type === "closeTab") return "closeTab";
  if (type === "dialog") return "dialog";
  if (type === "upload") return "upload";
  if (type === "wait") return "wait";
  if (type === "assert") return "assert";
  if (type === "extract") return "extract";
  return type || "action";
}

function rebuildTestFlowFromItem(item) {
  if (!item?.stepDetails) {
    item.testFlowSteps = [];
    item.testResults = [];
    return;
  }
  const oldResults = item.testResults || [];
  item.testFlowSteps = item.stepDetails.map((detail, index) => {
    const text = item.steps?.[index] || "";
    const kind = normalizeStepKind(detail.type);
    return {
      id: `step-${index}`,
      kind,
      url: detail.url || "",
      value: detail.value || "",
      text,
      target: detail.target
        ? {
            description: detail.target,
            candidates: [
              {
                kind: "text",
                value: detail.target,
                score: 0,
                source: "record",
              },
            ],
            observed: { tag: "div", text: detail.target },
          }
        : undefined,
      page: detail.tab > 1 ? { index: detail.tab - 1 } : undefined,
    };
  });
  item.testResults = item.testFlowSteps.map(
    (_, index) => oldResults[index] || { status: "pending" },
  );
}

async function rebuildItemTestFlow(item) {
  if (!item) return;
  // Prefer the persisted flow file when the UI draft has not diverged.
  if (item.flowFile && !item.nodeUpdates) {
    try {
      const flow = await F.flow.load(item.flowFile);
      if (flow) {
        item.testFlowSteps = (flow.steps || []).map((step) => step);
        item.testResults = item.testFlowSteps.map(() => ({
          status: "pending",
        }));
        return;
      }
    } catch {}
  }
  // Fall back to the current UI draft so Process/Instruction edits show in Test.
  rebuildTestFlowFromItem(item);
}

function bindStepEditor() {
  const panel = $("summaryResultPanel");
  if (!panel) return;
  panel.oninput = (e) => {
    const field = e.target.dataset.stepField,
      index = Number(e.target.dataset.stepIndex),
      item = currentAssistantItem();
    if (!field || !item) return;
    ensureStepDetails(item);
    if (field === "text") {
      item.steps[index] = e.target.value;
      const summary = e.target
        .closest(".instruction-step")
        ?.querySelector(".step-row-text");
      if (summary) summary.textContent = e.target.value;
    } else item.stepDetails[index][field] = e.target.value;
    item.nodeUpdates = true;
    rebuildItemTestFlow(item);
    renderAIPanel();
  };
  panel.onclick = (e) => {
    const button = e.target.closest("[data-instruction-expand]"),
      item = currentAssistantItem();
    if (!button || !item) return;
    const id = button.dataset.instructionExpand,
      expanded = button.getAttribute("aria-expanded") !== "true";
    item.instructionExpanded ??= [];
    item.instructionExpanded = item.instructionExpanded.filter(
      (value) => value !== id,
    );
    if (expanded) item.instructionExpanded.push(id);
    button.setAttribute("aria-expanded", String(expanded));
    button.querySelector("span").textContent = expanded ? "Collapse" : "Expand";
    button
      .closest(".steps-group")
      .querySelectorAll("[data-group-details]")
      .forEach((detail) => (detail.hidden = !expanded));
  };
}

const metricChoices = [
  [
    "User",
    [
      ["totalUsers", "Total Users"],
      ["activeUsers", "Active Users"],
    ],
  ],
  [
    "Execution",
    [
      ["totalExecution", "Total Execution"],
      ["durationPerExecution", "Duration Per Execution"],
      ["totalSuccessExecution", "Total Success Execution"],
      ["clicksPerExecution", "Clicks Per Execution"],
      ["autoClicksPerExecution", "Auto Clicks Per Execution"],
    ],
  ],
];
const metricDrafts = new Map();
function metricPreference() {
  if (!metricDrafts.has(activeFlowKey)) {
    let saved = [];
    try {
      const data = JSON.parse(
        localStorage.getItem("taskflow-metric-consent:" + activeFlowKey) ||
          "null",
      );
      saved = Array.isArray(data?.metrics)
        ? data.metrics.filter((id) =>
            metricChoices.some((group) =>
              group[1].some((option) => option[0] === id),
            ),
          )
        : [];
    } catch {}
    const allIds = metricChoices.flatMap((group) => group[1]).map(([id]) => id);
    const selected = saved.length ? [...saved] : [...allIds];
    metricDrafts.set(activeFlowKey, {
      saved: [...saved],
      selected: [...selected],
      message: "",
    });
  }
  return metricDrafts.get(activeFlowKey);
}

function metricMarkup(item) {
  if (!item) return "";
  const state = metricPreference();
  return `<form class="metric-consent" id="metricConsent" aria-label="Metric collection preferences"><p class="sr-only" id="metricConsentHint">Select the metrics you agree to share for platform statistics. Submit your choices to save them. You can change your choices and submit again.</p><div class="metric-consent-groups">${metricChoices.map(([name, options]) => `<section class="metric-consent-group" aria-label="${name}"><h3>${name}</h3><div class="metric-consent-options">${options.map(([id, label]) => `<label class="metric-consent-row"><input type="checkbox" class="recording-check" data-metric-choice="${id}" ${state.selected.includes(id) ? "checked" : ""}><span>${label}</span></label>`).join("")}</div></section>`).join("")}</div><div class="metric-consent-footer"><span role="status" id="metricConsentStatus">${escapeHTML(state.message)}</span><button class="btn" type="submit" id="metricSubmit" aria-describedby="metricConsentHint" disabled>Submit</button></div></form>`;
}

function bindMetricPreferences() {
  const form = $("metricConsent");
  if (!form) return;
  const state = metricPreference(),
    changed = () =>
      metricChoices
        .flatMap((group) => group[1])
        .some(
          ([id]) => state.selected.includes(id) !== state.saved.includes(id),
        );
  const sync = () => {
    $("metricSubmit").disabled = !changed();
  };
  form.onchange = () => {
    state.selected = [
      ...form.querySelectorAll("[data-metric-choice]:checked"),
    ].map((input) => input.dataset.metricChoice);
    state.message = "";
    $("metricConsentStatus").textContent = "";
    sync();
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    if (!changed()) return;
    try {
      localStorage.setItem(
        "taskflow-metric-consent:" + activeFlowKey,
        JSON.stringify({
          metrics: state.selected,
          updatedAt: new Date().toISOString(),
        }),
      );
      state.saved = [...state.selected];
      state.message = "Preferences saved.";
    } catch {
      state.message = "Unable to save preferences. Please try again.";
    }
    $("metricConsentStatus").textContent = state.message;
    sync();
  };
  sync();
}

// References belong to the recording being viewed; uploaded files stay in this browser session.
let referenceSequence = 0;
function ensureReferenceFiles(item) {
  if (!item) return [];
  if (!item.references) {
    const steps = item.steps || referenceOperation;
    const xml =
      '<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Steps"><Table><Row><Cell><Data ss:Type="String">Step</Data></Cell><Cell><Data ss:Type="String">Operation</Data></Cell></Row>' +
      steps
        .map(
          (line, i) =>
            `<Row><Cell><Data ss:Type="Number">${i + 1}</Data></Cell><Cell><Data ss:Type="String">${escapeHTML(line)}</Data></Cell></Row>`,
        )
        .join("") +
      "</Table></Worksheet></Workbook>";
    const markdown = steps.map((line, i) => `${i + 1}. ${line}`).join("\n");
    item.references = [
      {
        name: item.name + ".xls",
        type: "Excel",
        file: new Blob([xml], { type: "application/vnd.ms-excel" }),
      },
      {
        name: item.name + ".md",
        type: "MD",
        file: new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
      },
    ].map((file) => ({
      ...file,
      id: "reference-" + ++referenceSequence,
      url: URL.createObjectURL(file.file),
    }));
  }
  return item.references;
}

function referenceFilesMarkup(item) {
  const files = ensureReferenceFiles(item);
  return `<div class="reference-management"><div class="reference-table-wrap"><table class="reference-table" aria-label="Reference files"><colgroup><col class="reference-check-column"><col class="reference-name-column"><col><col class="reference-actions-column"></colgroup><thead><tr><th scope="col" class="reference-check-cell"><input type="checkbox" class="recording-check" id="referenceSelectAll" aria-label="Select all reference files" ${files.length ? "" : "disabled"}></th><th scope="col">Name</th><th scope="col">Type</th><th scope="col" aria-label="File actions"></th></tr></thead><tbody>${files.map((file) => `<tr data-reference-row="${file.id}"><td class="reference-check-cell"><input type="checkbox" class="recording-check" data-reference-check="${file.id}" aria-label="Select ${escapeHTML(file.name)}" ${file.selected ? "checked" : ""}></td><td>${item.referenceEditing === file.id ? `<input class="reference-name-input" id="referenceNameInput" aria-label="File name" value="${escapeHTML(file.name)}" required>` : `<a class="reference-name" href="${file.url}" download="${escapeHTML(file.name)}">${escapeHTML(file.name)}</a>`}</td><td>${escapeHTML(file.type)}</td><td class="reference-action-cell"><div class="reference-row-actions"><button type="button" class="icon-button" data-reference-edit="${file.id}" aria-label="Edit ${escapeHTML(file.name)}" title="Edit">${designIcon("edit")}</button><button type="button" class="icon-button" data-reference-delete="${file.id}" aria-label="Delete ${escapeHTML(file.name)}" title="Delete">${recordingDeleteIcon}</button></div></td></tr>`).join("")}</tbody></table></div><div class="reference-footer"><input type="file" id="referenceFileInput" accept=".xlsx,.xls,.csv,.md,.markdown" multiple hidden><button type="button" class="btn secondary" id="referenceDownload" ${files.length ? "" : "disabled"}>Download</button><button type="button" class="btn secondary" id="referenceUpload">Upload</button></div></div>`;
}
function bindReferenceFiles() {
  const input = $("referenceFileInput"),
    panel = $("summaryResultPanel"),
    item = currentAssistantItem();
  if (!input || !item) return;
  const redraw = () => {
    panel.innerHTML = referenceFilesMarkup(item);
    bindReferenceFiles();
  };
  const all = panel.querySelector("#referenceSelectAll");
  const syncChecks = () => {
    const files = ensureReferenceFiles(item),
      count = files.filter((file) => file.selected).length;
    all.checked = files.length > 0 && count === files.length;
    all.indeterminate = count > 0 && count < files.length;
    panel
      .querySelectorAll("[data-reference-check]")
      .forEach(
        (check) =>
          (check.checked = !!files.find(
            (file) => file.id === check.dataset.referenceCheck,
          )?.selected),
      );
  };
  all.onchange = () => {
    item.references.forEach((file) => (file.selected = all.checked));
    syncChecks();
  };
  panel.onchange = (e) => {
    const id = e.target.dataset.referenceCheck;
    if (!id) return;
    const file = item.references.find((file) => file.id === id);
    if (file) file.selected = e.target.checked;
    syncChecks();
  };
  syncChecks();
  const commit = () => {
    const field = $("referenceNameInput"),
      file = item.references.find((file) => file.id === item.referenceEditing);
    if (!file) return;
    const name = field?.value.trim();
    if (name) file.name = name;
    delete item.referenceEditing;
    redraw();
  };
  panel.onpointerdown = (e) => {
    if (item.referenceEditing && e.target.closest("button")) e.preventDefault();
  };
  $("referenceDownload").onclick = () => {
    if (item.referenceEditing) commit();
    downloadReferenceArchive(item);
  };
  $("referenceUpload").onclick = () => {
    if (item.referenceEditing) commit();
    $("referenceFileInput").click();
  };
  input.onchange = () => {
    for (const file of input.files) {
      const ext = file.name.split(".").pop().toLowerCase(),
        type = ["xlsx", "xls", "csv"].includes(ext)
          ? "Excel"
          : ["md", "markdown"].includes(ext)
            ? "MD"
            : ext.toUpperCase();
      item.references.push({
        id: "reference-" + ++referenceSequence,
        name: file.name,
        type,
        file,
        url: URL.createObjectURL(file),
      });
    }
    redraw();
    $("referenceUpload").focus();
  };
  panel.onclick = async (e) => {
    const edit = e.target.closest("[data-reference-edit]"),
      remove = e.target.closest("[data-reference-delete]");
    if (edit) {
      if (item.referenceEditing) commit();
      item.referenceEditing = edit.dataset.referenceEdit;
      redraw();
      const field = $("referenceNameInput");
      field.focus();
      field.select();
    }
    if (remove) {
      const index = item.references.findIndex(
        (file) => file.id === remove.dataset.referenceDelete,
      );
      if (index < 0) return;
      if (
        !(await confirmWorkspaceAction(
          `Delete file “${item.references[index].name}”?`,
        ))
      )
        return;
      item.references.splice(index, 1);
      delete item.referenceEditing;
      redraw();
      const next = panel.querySelector("[data-reference-delete]");
      (next || $("referenceUpload")).focus();
    }
  };
  const field = $("referenceNameInput");
  if (field) {
    field.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        delete item.referenceEditing;
        redraw();
      }
    };
    field.onblur = commit;
  }
}

function bindScreenshotZoom() {
  const panel = $("summaryResultPanel");
  if (!panel) return;
  panel.onclick = (e) => {
    const trigger = e.target.closest("[data-screenshot-zoom]");
    if (!trigger) return;
    e.preventDefault();
    const src = trigger.dataset.screenshotZoom;
    const overlay = document.createElement("dialog");
    overlay.className = "screenshot-zoom-overlay";
    overlay.innerHTML = `<button type="button" class="screenshot-zoom-close" aria-label="Close">Close</button><img src="${escapeHTML(src)}" alt="Zoomed screenshot">`;
    document.body.appendChild(overlay);
    overlay.showModal();
    overlay.onclick = (event) => {
      if (
        event.target === overlay ||
        event.target.closest(".screenshot-zoom-close")
      ) {
        overlay.close();
        overlay.remove();
      }
    };
  };
}

function processMapMarkup(item) {
  if (!item) return "";
  const groups = ensureProcessGroups(item);
  return `
  <div class="process-canvas" tabindex="0" aria-label="Process canvas">
    <div class="process-canvas-world">
      ${groups.map((group) => `
      <section class="canvas-group ${item.selectedGroup === group.id ? "selected" : ""}" data-canvas-group="${group.id}">
        <img class="canvas-group-icon" src="${groupFaviconUrl(group.url)}" alt="" loading="lazy" onerror="this.src='${genericGroupIcon}';this.onerror=null">
        <button class="canvas-group-heading" data-group-select="${group.id}" aria-pressed="${item.selectedGroup === group.id}">
          ${group.number} · ${escapeHTML(group.name)}
        </button>
        <div class="canvas-group-actions" ${item.selectedGroup === group.id ? "" : "hidden"}>
          <button data-group-record="${group.id}">Re-record</button>
          <button data-group-insert="before" data-group-id="${group.id}">Add recording before</button>
          <button data-group-insert="after" data-group-id="${group.id}">Add recording after</button>
          <button data-group-delete="${group.id}">Delete</button>
        </div>
        <div class="canvas-group-nodes">
          ${group.steps.map((text, index) => `
          <div class="canvas-step" data-canvas-step-index="${group.start + index}">
            <span>${group.number}-${String(index + 1).padStart(3, "0")}</span>
            <span>${escapeHTML(text)}</span>
            <!-- 
              // TODO: conditional manual icon
              <span class="execution-mode-icon" role="img" aria-label="Manual" title="Manual">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="7" r="4"></circle>
                  <path d="M4 21v-2a8 8 0 0 1 16 0v2"></path>
                </svg>
              </span> 
            -->
            <span class="execution-mode-icon" role="img" aria-label="Automated" title="Automated">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="4" y="7" width="16" height="13" rx="2"></rect>
                <path d="M12 3v4M1 12h3M20 12h3M8 16h8"></path>
                <circle cx="9" cy="12" r=".5"></circle>
                <circle cx="15" cy="12" r=".5"></circle>
              </svg>
            </span>
          </div>`).join("")
          }
        </div>
      </section>`).join("")
      }
    </div>
    <div class="canvas-step-menu" id="canvasStepMenu" hidden>
      <button data-step-modify>Modify</button>
      <button data-step-break>Break</button>
    </div>
    <div class="canvas-view-controls">
      <button data-canvas-zoom="out" aria-label="Zoom out">-</button>
      <span class="canvas-zoom-label">100%</span>
      <button data-canvas-zoom="in" aria-label="Zoom in">+</button>
      <button data-canvas-fit>Fit to canvas</button>
    </div>
  </div>`;
}
let processCanvasObserver;
function bindProcessMap() {
  processCanvasObserver?.disconnect();
  const panel = $("summaryResultPanel"),
    canvas = panel?.querySelector(".process-canvas"),
    item = currentAssistantItem();
  if (!canvas || !item) return;
  const world = canvas.querySelector(".process-canvas-world");
  let zoom = 1,
    x = 0,
    y = 0,
    drag = null;
  const paint = () => {
    world.style.setProperty("--canvas-action-scale", String(1 / zoom));
    world.style.transform = `translate(${x}px,${y}px) scale(${zoom})`;
    canvas.querySelector(".canvas-zoom-label").textContent =
      Math.round(zoom * 100) + "%";
  };
  const fit = () => {
    zoom = Math.min(
      1,
      (canvas.clientHeight - 64) / world.offsetHeight,
      (canvas.clientWidth - 80) / world.offsetWidth,
    );
    zoom = Math.max(0.2, zoom);
    x = (canvas.clientWidth - world.offsetWidth * zoom) / 2;
    y = Math.max(24, (canvas.clientHeight - world.offsetHeight * zoom) / 2);
    paint();
  };
  const scale = (
    factor,
    cx = canvas.clientWidth / 2,
    cy = canvas.clientHeight / 2,
  ) => {
    const previous = zoom;
    zoom = Math.max(0.2, Math.min(2, zoom * factor));
    x = cx - ((cx - x) * zoom) / previous;
    y = cy - ((cy - y) * zoom) / previous;
    paint();
  };
  processCanvasObserver = new ResizeObserver(fit);
  processCanvasObserver.observe(canvas);
  processCanvasObserver.observe(world);
  panel.onclick = (e) => {
    if (!e.target.closest("#canvasStepMenu")) hideStepMenu();
    const select =
      e.target.closest("[data-group-select]") ||
      (!e.target.closest("button")
        ? e.target.closest("[data-canvas-group]")
        : null);
    if (select) {
      item.selectedGroup =
        select.dataset.groupSelect || select.dataset.canvasGroup;
      canvas.querySelectorAll("[data-canvas-group]").forEach((group) => {
        const selected = group.dataset.canvasGroup === item.selectedGroup;
        group.classList.toggle("selected", selected);
        group.querySelector(".canvas-group-actions").hidden = !selected;
        group
          .querySelector(".canvas-group-heading")
          .setAttribute("aria-pressed", String(selected));
      });
      renderAIPanel();
    } else if (
      !e.target.closest(".canvas-view-controls,.canvas-group-actions")
    ) {
      item.selectedGroup = null;
      canvas.querySelectorAll("[data-canvas-group]").forEach((group) => {
        group.classList.remove("selected");
        group.querySelector(".canvas-group-actions").hidden = true;
        group
          .querySelector(".canvas-group-heading")
          .setAttribute("aria-pressed", "false");
      });
      renderAIPanel();
    }
    const record = e.target.closest("[data-group-record]"),
      remove = e.target.closest("[data-group-delete]"),
      insert = e.target.closest("[data-group-insert]");
    if (record) {
      e.preventDefault();
      e.stopPropagation();
      beginGroupRecording(item, record.dataset.groupRecord, "replace");
    }
    if (remove) deleteProcessGroup(item, remove.dataset.groupDelete);
    if (insert) {
      e.preventDefault();
      e.stopPropagation();
      beginGroupRecording(
        item,
        insert.dataset.groupId,
        insert.dataset.groupInsert,
      );
    }
    const z = e.target.closest("[data-canvas-zoom]");
    if (z) scale(z.dataset.canvasZoom === "in" ? 1.2 : 1 / 1.2);
    if (e.target.closest("[data-canvas-fit]")) fit();
  };
  canvas.onwheel = (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    scale(
      e.deltaY < 0 ? 1.1 : 1 / 1.1,
      e.clientX - rect.left,
      e.clientY - rect.top,
    );
  };
  canvas.onpointerdown = (e) => {
    if (
      e.button !== 0 ||
      e.target.closest(
        ".canvas-group,.canvas-view-controls,#canvasStepMenu,.canvas-group-actions",
      )
    )
      return;
    drag = { x: e.clientX, y: e.clientY, ox: x, oy: y };
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add("panning");
  };
  canvas.onpointermove = (e) => {
    if (!drag) return;
    x = drag.ox + e.clientX - drag.x;
    y = drag.oy + e.clientY - drag.y;
    paint();
  };
  const end = () => {
    drag = null;
    canvas.classList.remove("panning");
  };
  canvas.onpointerup = end;
  canvas.onpointercancel = end;
  canvas.onkeydown = (e) => {
    if (e.target !== canvas) return;
    if (["+", "=", "-", "0"].includes(e.key)) {
      e.preventDefault();
      if (e.key === "0") fit();
      else scale(e.key === "-" ? 1 / 1.2 : 1.2);
    } else if (e.key === "Escape") {
      item.selectedGroup = null;
      canvas.querySelectorAll(".canvas-group").forEach((g) => {
        g.classList.remove("selected");
        g.querySelector(".canvas-group-actions").hidden = true;
        g.querySelector(".canvas-group-heading").setAttribute(
          "aria-pressed",
          "false",
        );
      });
      renderAIPanel();
    }
  };
  const stepMenu = canvas.querySelector("#canvasStepMenu");
  const hideStepMenu = () => {
    stepMenu.hidden = true;
    stepMenu.dataset.stepIndex = "";
  };
  const showStepMenu = (e, stepIndex) => {
    e.preventDefault();
    e.stopPropagation();
    hideStepMenu();
    const stepEl = e.target.closest(".canvas-step");
    if (!stepEl) return;
    const groupEl = stepEl.closest("[data-canvas-group]");
    const groupId = groupEl?.dataset.canvasGroup;
    const group = groupId
      ? ensureProcessGroups(item).find((g) => g.id === groupId)
      : null;
    if (!group) return;
    const isFirst = Number(stepIndex) === group.start;
    stepMenu.querySelector("[data-step-break]").disabled = isFirst;
    stepMenu.dataset.stepIndex = String(stepIndex);
    const rect = canvas.getBoundingClientRect();
    stepMenu.style.left =
      Math.min(rect.width - 128, Math.max(0, e.clientX - rect.left)) + "px";
    stepMenu.style.top =
      Math.min(rect.height - 96, Math.max(0, e.clientY - rect.top)) + "px";
    stepMenu.hidden = false;
  };
  canvas.oncontextmenu = (e) => {
    const step = e.target.closest(".canvas-step");
    if (step) {
      showStepMenu(e, step.dataset.canvasStepIndex);
      return false;
    }
    hideStepMenu();
  };
  stepMenu.onclick = (e) => {
    e.stopPropagation();
    const stepIndex = Number(stepMenu.dataset.stepIndex);
    if (isNaN(stepIndex)) return;
    if (e.target.closest("[data-step-modify]")) {
      hideStepMenu();
      const groups = ensureProcessGroups(item);
      const group = groups.find(
        (g) => g.start <= stepIndex && stepIndex < g.start + g.count,
      );
      if (!group) return;
      item.resultTab = "Instruction";
      item.instructionExpanded ??= [];
      if (!item.instructionExpanded.includes(group.id))
        item.instructionExpanded.push(group.id);
      renderSummaryWorkspace();
      setTimeout(() => {
        const row = panel?.querySelector(`[data-step-index="${stepIndex}"]`);
        row?.scrollIntoView({ behavior: "smooth", block: "center" });
        row?.focus();
      }, 50);
    } else if (e.target.closest("[data-step-break]")) {
      hideStepMenu();
      const groups = ensureProcessGroups(item);
      const idx = groups.findIndex(
        (g) => g.start <= stepIndex && stepIndex < g.start + g.count,
      );
      if (idx < 0) return;
      const g = groups[idx];
      if (stepIndex === g.start) return;
      const firstCount = stepIndex - g.start;
      const secondCount = g.count - firstCount;
      const first = { ...g, count: firstCount };
      const second = {
        id: "group-" + ++processGroupSequence,
        name: g.name,
        count: secondCount,
      };
      item.processGroups.splice(idx, 1, first, second);
      item.selectedGroup = second.id;
      item.nodeUpdates = true;
      renderSummaryWorkspace();
    }
  };
  requestAnimationFrame(fit);
}
async function beginGroupRecording(item, groupId, mode) {
  const state = recordingSession();
  if (state.stage === "recording") return;
  const group = ensureProcessGroups(item).find((g) => g.id === groupId);
  if (!group) return;
  const message =
    mode === "replace"
      ? `Re-record node ${group.number}? This will replace its recorded steps.`
      : mode === "before"
        ? "Add a new recording before this node?"
        : "Add a new recording after this node?";
  if (!(await confirmWorkspaceAction(message))) return;
  state.aiOpen = false;
  state.view = "browser";
  while (state.browserTabs.length > 1) {
    const extra = state.browserTabs[state.browserTabs.length - 1];
    await F.browser.closeTab(extra.nativeId || extra.id);
    state.browserTabs.pop();
  }
  state.activeBrowserTab = state.browserTabs[0].id;
  await F.browser.switchTab("browser");
  const page = activeBrowserPage();
  let targetUrl = item.url || "";
  if (item.flowFile) {
    try {
      const flow = await F.flow.load(item.flowFile);
      targetUrl = flow?.meta?.env?.startUrl || targetUrl;
    } catch {}
  }
  if (!targetUrl || targetUrl === "about:blank") targetUrl = recordingTestURL;
  page.url = targetUrl;
  page.draftURL = targetUrl;
  page.history = [targetUrl];
  page.historyIndex = 0;
  state.url = targetUrl;
  state.route =
    targetUrl.match(
      /^local:\/\/procurement\/(suppliers|draft|receipts)$/,
    )?.[1] || "";
  syncBrowserSession();
  state.pending = {
    reRecordTarget: item.id,
    groupId,
    groupMode: mode,
    actions: [],
    startedAt: Date.now(),
  };
  await navigateRecordingBrowser(targetUrl);
  state.stage = "ready";
  state.view = "browser";
  state.focused = item.id;
  renderRecordingWorkspace();
  await startBrowserRecording();
}
function finishGroupRecording(state, pending, item) {
  const group = ensureProcessGroups(item).find((g) => g.id === pending.groupId);
  if (!group) return;
  const steps =
    Array.isArray(pending.recordedSteps) && pending.recordedSteps.length
      ? pending.recordedSteps
      : pending.actions
          .map((action) =>
            action.type === "input"
              ? `在【${action.target}】中填写：${action.value}`
              : action.type === "click"
                ? `点击【${action.target}】`
                : action.type === "navigate"
                  ? `打开 ${action.url}`
                  : "",
          )
          .filter(Boolean);
  if (steps.length) {
    ensureStepDetails(item);
    let position;
    if (pending.groupMode === "replace") {
      position = group.start;
      item.steps.splice(group.start, group.count, ...steps);
      item.stepDetails.splice(
        group.start,
        group.count,
        ...(pending.recordedDetails ||
          item.stepDetails.slice(group.start, group.start + group.count)),
      );
    } else {
      const after = pending.groupMode === "after";
      position = group.start + (after ? group.count : 0);
      item.steps.splice(position, 0, ...steps);
      item.stepDetails.splice(
        position,
        0,
        ...(pending.recordedDetails ||
          steps.map((text) => ({
            type: "click",
            target: "",
            value: "",
            tab: 1,
          }))),
      );
    }
    if (pending.media) {
      const oldScreenshots = item.media?.screenshots || [];
      const newScreenshots = pending.media.screenshots || [];
      const spliceCount = pending.groupMode === "replace" ? group.count : 0;
      const updated = [
        ...oldScreenshots.slice(0, position),
        ...newScreenshots,
        ...oldScreenshots.slice(position + spliceCount),
      ];
      const finalScreenshots = updated.slice(0, item.steps.length);
      while (finalScreenshots.length < item.steps.length) {
        finalScreenshots.push({
          image: "",
          name: `Screenshot-${String(finalScreenshots.length + 1).padStart(2, "0")}.png`,
        });
      }
      finalScreenshots.forEach((s, i) => {
        s.name = `Screenshot-${String(i + 1).padStart(2, "0")}.png`;
        if (!s.image) s.image = "";
      });
      item.media = { ...(item.media || {}), screenshots: finalScreenshots };
    }
    item.processGroups = buildTabGroupsForItem(item);
    const enriched = ensureProcessGroups(item);
    const selected = enriched.find(
      (g) => g.start <= position && position < g.start + g.count,
    );
    item.selectedGroup = selected?.id || enriched[0]?.id || null;
    item.nodeUpdates = true;
    rebuildItemTestFlow(item);
  }
  item.resultTab = "Process";
  state.focused = item.id;
  state.view = "analysis";
  state.stage = "done";
  state.pending = null;
  renderRecordingWorkspace();
  if (window.flowlink?.browser?.hide) window.flowlink.browser.hide();
}

async function deleteProcessGroup(item, groupId) {
  const group = ensureProcessGroups(item).find((g) => g.id === groupId);
  if (!group) return;
  if (
    !(await confirmWorkspaceAction(
      `Delete node ${group.number} and all its steps?`,
    ))
  )
    return;
  item.steps.splice(group.start, group.count);
  item.stepDetails?.splice(group.start, group.count);
  const screenshots = item.media?.screenshots || [];
  if (screenshots.length) {
    screenshots.splice(group.start, group.count);
    screenshots.forEach((s, i) => {
      s.name = `Screenshot-${String(i + 1).padStart(2, "0")}.png`;
    });
  }
  item.processGroups = buildTabGroupsForItem(item);
  item.selectedGroup = null;
  item.nodeUpdates = true;
  rebuildItemTestFlow(item);
  renderSummaryWorkspace();
}

// Uncompressed ZIP download preserves every original file byte and filename.
async function downloadReferenceArchive(item) {
  const files = ensureReferenceFiles(item);
  if (!files.length) return;
  const parts = [],
    central = [];
  let offset = 0,
    centralSize = 0;
  const crc32 = (data) => {
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  for (const file of files) {
    const name = new TextEncoder().encode(file.name),
      data = new Uint8Array(await file.file.arrayBuffer()),
      crc = crc32(data),
      header = new Uint8Array(30 + name.length),
      h = new DataView(header.buffer);
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);
    h.setUint16(6, 0x800, true);
    h.setUint32(14, crc, true);
    h.setUint32(18, data.length, true);
    h.setUint32(22, data.length, true);
    h.setUint16(26, name.length, true);
    header.set(name, 30);
    parts.push(header, data);
    const directory = new Uint8Array(46 + name.length),
      d = new DataView(directory.buffer);
    d.setUint32(0, 0x02014b50, true);
    d.setUint16(4, 20, true);
    d.setUint16(6, 20, true);
    d.setUint16(8, 0x800, true);
    d.setUint32(16, crc, true);
    d.setUint32(20, data.length, true);
    d.setUint32(24, data.length, true);
    d.setUint16(28, name.length, true);
    d.setUint32(42, offset, true);
    directory.set(name, 46);
    central.push(directory);
    centralSize += directory.length;
    offset += header.length + data.length;
  }
  const end = new Uint8Array(22),
    e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, centralSize, true);
  e.setUint32(16, offset, true);
  const url = URL.createObjectURL(
      new Blob([...parts, ...central, end], { type: "application/zip" }),
    ),
    link = document.createElement("a");
  link.href = url;
  link.download = item.name + ".zip";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Local embedded-demo capture only. External origins are not screen-recorded.
function embeddedSnapshotBridge() {
  document.addEventListener(
    "click",
    (e) => {
      const target = e.target.closest(
        "button,a,input[type=checkbox],input[type=radio]",
      );
      if (target)
        parent.postMessage(
          {
            type: "flowlink-click",
            target: (
              target.textContent ||
              target.getAttribute("aria-label") ||
              target.name ||
              "选项"
            )
              .trim()
              .slice(0, 100),
          },
          "*",
        );
    },
    true,
  );
  let scheduled;
  function snapshot() {
    const width = innerWidth,
      height = innerHeight,
      canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#F7F8FA";
    ctx.fillRect(0, 0, width, height);
    const elements = [
      document.body,
      ...document.body.querySelectorAll("*"),
    ].filter((e) => !["SCRIPT", "STYLE"].includes(e.tagName));
    function text(value, x, y, maxWidth, style) {
      const size = parseFloat(style.fontSize) || 14,
        line = parseFloat(style.lineHeight) || size * 1.45;
      ctx.font = `${style.fontWeight} ${size}px ${style.fontFamily}`;
      ctx.fillStyle = style.color;
      ctx.textBaseline = "top";
      let row = "",
        top = y;
      for (const char of value) {
        if (char === "\n" || ctx.measureText(row + char).width > maxWidth) {
          ctx.fillText(row, x, top);
          row = char === "\n" ? "" : char;
          top += line;
        } else row += char;
      }
      ctx.fillText(row, x, top);
    }
    for (const e of elements) {
      const r = e.getBoundingClientRect(),
        s = getComputedStyle(e);
      if (
        !r.width ||
        !r.height ||
        r.bottom < 0 ||
        r.top > height ||
        s.visibility === "hidden"
      )
        continue;
      if (
        s.backgroundColor !== "rgba(0, 0, 0, 0)" &&
        s.backgroundColor !== "transparent"
      ) {
        ctx.fillStyle = s.backgroundColor;
        ctx.fillRect(r.x, r.y, r.width, r.height);
      }
      for (const [side, x, y, w, h] of [
        ["Top", r.x, r.y, r.width, parseFloat(s.borderTopWidth)],
        [
          "Bottom",
          r.x,
          r.bottom - parseFloat(s.borderBottomWidth),
          r.width,
          parseFloat(s.borderBottomWidth),
        ],
        ["Left", r.x, r.y, parseFloat(s.borderLeftWidth), r.height],
        [
          "Right",
          r.right - parseFloat(s.borderRightWidth),
          r.y,
          parseFloat(s.borderRightWidth),
          r.height,
        ],
      ])
        if (w && h) {
          ctx.fillStyle = s["border" + side + "Color"];
          ctx.fillRect(x, y, w, h);
        }
      if (e.matches("input,select,textarea")) {
        text(
          e.value,
          r.x + parseFloat(s.paddingLeft) + 1,
          r.y + (r.height - parseFloat(s.fontSize)) / 2,
          r.width - 12,
          s,
        );
        continue;
      }
      for (const n of e.childNodes) {
        if (n.nodeType !== 3 || !n.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        const tr = range.getBoundingClientRect();
        if (tr.width)
          text(
            n.textContent.trim(),
            tr.x,
            tr.y,
            Math.max(
              tr.width,
              r.width - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight),
            ),
            s,
          );
      }
    }
    parent.postMessage(
      {
        type: "flowlink-snapshot",
        image: canvas.toDataURL("image/png"),
        width,
        height,
      },
      "*",
    );
  }
  window.addEventListener("message", (e) => {
    if (e.source === parent && e.data?.type === "flowlink-snapshot-request")
      snapshot();
  });
  document.addEventListener("input", () => {
    clearTimeout(scheduled);
    scheduled = setTimeout(snapshot, 180);
  });
}
function requestRecordingSnapshot() {
  const state = recordingSession();
  if (
    state.stage === "recording" &&
    (!state.url || state.url.startsWith("local://procurement/"))
  )
    $("recordingFrame")?.contentWindow.postMessage(
      { type: "flowlink-snapshot-request" },
      "*",
    );
}
function startRecordingMedia(state) {
  const canvas = document.createElement("canvas");
  canvas.width = 960;
  canvas.height = 540;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, 960, 540);
  const media = {
    canvas,
    ctx,
    screenshots: [],
    lastImage: "",
    chunks: [],
    startedAt: performance.now(),
    recorder: null,
    stream: null,
  };
  state.mediaCapture = media;
  if (typeof MediaRecorder !== "undefined" && canvas.captureStream) {
    try {
      media.stream = canvas.captureStream(10);
      const type = [
        "video/webm;codecs=vp9",
        "video/webm;codecs=vp8",
        "video/webm",
      ].find((t) => MediaRecorder.isTypeSupported(t));
      media.recorder = new MediaRecorder(
        media.stream,
        type ? { mimeType: type } : undefined,
      );
      media.recorder.ondataavailable = (e) => {
        if (e.data.size) media.chunks.push(e.data);
      };
      media.recorder.start();
    } catch {}
  }
  media.paint = () => {
    if (!media.frame) return;
    const scale = Math.min(960 / media.frame.width, 540 / media.frame.height),
      w = media.frame.width * scale,
      h = media.frame.height * scale;
    ctx.fillStyle = "#101416";
    ctx.fillRect(0, 0, 960, 540);
    ctx.drawImage(media.frame, (960 - w) / 2, (540 - h) / 2, w, h);
  };
  media.timer = setInterval(() => {
    media.paint();
    requestRecordingSnapshot();
  }, 100);
  requestRecordingSnapshot();
}
function receiveRecordingSnapshot(data) {
  const state = recordingSession(),
    media = state.mediaCapture;
  if (
    !media ||
    state.stage !== "recording" ||
    typeof data.image !== "string" ||
    !data.image.startsWith("data:image/png;base64,")
  )
    return;
  if (media.lastImage === data.image) return;
  media.lastImage = data.image;
  const image = new Image();
  image.onload = () => {
    if (state.mediaCapture !== media) return;
    media.frame = image;
    media.paint();
  };
  image.src = data.image;
  media.screenshots.push({
    image: data.image,
    name: `Screenshot-${String(media.screenshots.length + 1).padStart(2, "0")}.png`,
  });
}
async function stopRecordingMedia(state) {
  const media = state.mediaCapture;
  if (!media) return { videoURL: "", screenshots: [] };
  requestRecordingSnapshot();
  await new Promise((resolve) => setTimeout(resolve, 100));
  clearInterval(media.timer);
  let videoURL = "";
  if (media.recorder?.state === "recording") {
    await new Promise((resolve) => {
      media.recorder.onstop = resolve;
      media.recorder.stop();
    });
    if (media.screenshots.length && media.chunks.length)
      videoURL = URL.createObjectURL(
        new Blob(media.chunks, { type: media.recorder.mimeType }),
      );
  }
  media.stream?.getTracks().forEach((track) => track.stop());
  state.mediaCapture = null;
  return { videoURL, screenshots: media.screenshots };
}
function recordingMediaMarkup(item) {
  const media = item?.media || {},
    screenshots = media.screenshots || [];
  const poster = media.posterFile
    ? `file:///${String(media.posterFile).replace(/\\/g, "/")}`
    : screenshots[0]?.image || "";
  return `<div class="recording-media"><section class="recording-video">${media.videoURL ? `<video controls playsinline preload="metadata" aria-label="${escapeHTML(item?.name || "Recording")} video" src="${escapeHTML(media.videoURL)}"></video>` : poster ? `<div class="recording-frame-preview"><img src="${escapeHTML(poster)}" alt="${escapeHTML(item?.name || "Recording")} poster"><span>Recorded video frames</span></div>` : `<div class="recording-frame-preview recording-frame-empty">No recorded video frames found</div>`}<div class="recording-media-name">${escapeHTML(item?.name || "Recording")}${media.videoURL ? ".webm" : " - frame recording"}</div></section><div class="recording-screenshots">${screenshots.map((file) => `<button type="button" class="recording-screenshot-file" data-screenshot-zoom="${escapeHTML(file.image)}" aria-label="Zoom ${escapeHTML(file.name)}"><img src="${file.image}" alt="${escapeHTML(file.name)}"><span>${escapeHTML(file.name)}</span></button>`).join("")}</div></div>`;
}

// Native pointer and keyboard resizing. No layout labels or icons are added.
let workspaceResizeObserver;
function workspaceWidthBounds(layout) {
  const total = layout.getBoundingClientRect().width;
  return { min: 298, max: Math.max(298, total - 16 - 320) };
}
function setWorkspaceWidth(value) {
  const layout = $("designPanel").querySelector(
      ".recording-layout:not([hidden])",
    ),
    separator = $("workspaceSplitter");
  if (!layout || !separator) return;
  const limits = workspaceWidthBounds(layout),
    width = Math.max(limits.min, Math.min(limits.max, value));
  recordingSession().listWidth = width;
  layout.style.setProperty("--recording-list-width", width + "px");
  separator.setAttribute("aria-valuemin", String(limits.min));
  separator.setAttribute("aria-valuemax", String(Math.round(limits.max)));
  separator.setAttribute("aria-valuenow", String(Math.round(width)));
}
function bindWorkspaceResize() {
  workspaceResizeObserver?.disconnect();
  const layout = $("designPanel").querySelector(
      ".recording-layout:not([hidden])",
    ),
    separator = $("workspaceSplitter");
  if (!layout || !separator) return;
  const state = recordingSession();
  if (state.listWidth) setWorkspaceWidth(state.listWidth);
  const refresh = () => {
    if (getComputedStyle(separator).display === "none") return;
    const width =
      state.listWidth ??
      layout.querySelector(".recording-list").getBoundingClientRect().width;
    setWorkspaceWidth(width);
  };
  workspaceResizeObserver = new ResizeObserver(refresh);
  workspaceResizeObserver.observe(layout);
  refresh();
  separator.onpointerdown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    separator.setPointerCapture(e.pointerId);
    document.body.classList.add("workspace-resizing");
  };
  separator.onpointermove = (e) => {
    if (separator.hasPointerCapture(e.pointerId))
      setWorkspaceWidth(e.clientX - layout.getBoundingClientRect().left);
  };
  const finish = (e) => {
    if (separator.hasPointerCapture(e.pointerId))
      separator.releasePointerCapture(e.pointerId);
    document.body.classList.remove("workspace-resizing");
  };
  separator.onpointerup = finish;
  separator.onpointercancel = finish;
  separator.onkeydown = (e) => {
    const current = layout
        .querySelector(".recording-list")
        .getBoundingClientRect().width,
      limits = workspaceWidthBounds(layout);
    let next;
    if (e.key === "ArrowLeft") next = current - 24;
    else if (e.key === "ArrowRight") next = current + 24;
    else if (e.key === "Home") next = limits.min;
    else if (e.key === "End") next = limits.max;
    else return;
    e.preventDefault();
    setWorkspaceWidth(next);
  };
}
function assistantWidthBounds() {
  return {
    min: Math.min(260, Math.max(180, innerWidth * 0.35)),
    max: Math.max(260, Math.min(640, innerWidth - 48 - 700)),
  };
}
function setAssistantWidth(value) {
  const bounds = assistantWidthBounds(),
    width = Math.max(bounds.min, Math.min(bounds.max, value));
  recordingSession().aiWidth = width;
  $("drawer").style.setProperty("--assistant-width", width + "px");
  const separator = $("assistantResize");
  separator.setAttribute("aria-valuemin", String(Math.round(bounds.min)));
  separator.setAttribute("aria-valuemax", String(Math.round(bounds.max)));
  separator.setAttribute("aria-valuenow", String(Math.round(width)));
}
function bindAssistantResize() {
  const separator = $("assistantResize");
  setAssistantWidth(recordingSession().aiWidth || 320);
  separator.onpointerdown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    separator.setPointerCapture(e.pointerId);
    document.body.classList.add("workspace-resizing");
  };
  separator.onpointermove = (e) => {
    if (separator.hasPointerCapture(e.pointerId))
      setAssistantWidth(
        $("recordingAssistant").getBoundingClientRect().right - e.clientX,
      );
  };
  const finish = (e) => {
    if (separator.hasPointerCapture(e.pointerId))
      separator.releasePointerCapture(e.pointerId);
    document.body.classList.remove("workspace-resizing");
  };
  separator.onpointerup = finish;
  separator.onpointercancel = finish;
  separator.onkeydown = (e) => {
    let value = recordingSession().aiWidth || 320;
    const bounds = assistantWidthBounds();
    if (e.key === "ArrowLeft") value += 24;
    else if (e.key === "ArrowRight") value -= 24;
    else if (e.key === "Home") value = bounds.min;
    else if (e.key === "End") value = bounds.max;
    else return;
    e.preventDefault();
    setAssistantWidth(value);
  };
}

render();
