"use strict";
/*
 * FlowLink 渲染器侧的界面控制器。此文件负责页面内存中的 Flow/Profile 草稿、
 * 抽屉导航、录制会话状态，以及列表和 Design 工作区的渲染与事件绑定。
 * 独立演示模式会模拟浏览器操作和分析；Electron preload 可用时，bridge.js
 * 会将部分函数替换为通过 IPC 调用的实现。observed 界面状态应与已持久化的 Flow 数据分开。
 */
// 范围：Flow 列表、Profile，以及提供的四态 Design 录制界面。
// Service Level 选项来自主进程加载的流程层级目录；Category 和远程服务仍为演示状态。
// SVG 资源直接嵌入自提供的文件。
const flowData = [];
const serviceLevelIds = [
  "serviceLine",
  "serviceLine2",
  "serviceLine3",
  "serviceLine4",
];
let processLandscape = null;

// 页面级模板（index.html 底部 <template>）的克隆入口。
const rowTemplate = (id) => document.getElementById(id).content.firstElementChild;

// 列表行操作按钮的禁用规则；bridge.js 在 IPC 模式下按真实录制状态覆盖。
function flowRowActionDisabled(name, flow) {
  if (name === "run") return !flow?.enabled;
  if (name === "delete") return true;
  return false;
}

// 优先在当前显示的 Design 工作区内查找 ID：每个 Flow 都有独立的录制布局副本，
// 若直接全局查找，隐藏副本中的同名 ID 可能会遮蔽当前活动元素。
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

// SVG 元素没有 reflected 的 hidden IDL 属性：直接赋值只挂一个 expando 属性，
// CSS [hidden] 选择器匹配不到，图标显隐必须走 attribute。
function setIconHidden(element, hidden) {
  if (hidden) element.setAttribute("hidden", "");
  else element.removeAttribute("hidden");
}

// 版本号统一为 vX.Y.Z；无法解析的旧值（r1/V1）在下次保存时归一为 v1.0.0。
function nextTaskVersion(current) {
  const match = /v(\d+)\.(\d+)\.(\d+)/i.exec(String(current || ""));
  if (!match) return "v1.0.0";
  return `v${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function taskVersionLabel(flow) {
  const rows = flow?.versions;
  return (rows?.length ? rows[rows.length - 1].name : flow?.version) || "v1.0.0";
}

// Import 子菜单在点击页面其他位置或按 Escape 时关闭。
document.addEventListener("click", (e) => {
  const menu = $("recordingImportMenu");
  if (menu && !menu.hidden && !e.target.closest(".recording-import"))
    closeImportMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeImportMenu();
});

let appliedName = "";
let  appliedVersion = "";
let appliedSearch = "";
let appliedCategory = "";
let activeStatus = "All";
let currentFlow = null;
let trigger = null;
let initialName = "";
let savedScroll = 0;
let processLandscapeError = "";
const profileDrafts = new Map();

function completeProcessNodes(nodes, level) {
  return nodes.filter(
    (node) =>
      level === 4 ||
      completeProcessNodes(node.children, level + 1).length > 0,
  );
}

function servicePickerPopup(trigger) {
  return document.getElementById(trigger.getAttribute("aria-controls") || "");
}

function updateServiceTrigger(trigger, value) {
  trigger.dataset.value = value;
  trigger.querySelector("span").textContent = value || "Please select";
  trigger.classList.toggle("is-empty", !value);
  trigger.removeAttribute("aria-invalid");
}

function renderServicePickerOptions(trigger, options) {
  const list = servicePickerPopup(trigger)?.querySelector(
    ".service-picker-options",
  );
  if (!list) return;
  list.replaceChildren(
    ...options.map((option) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "service-picker-option";
      button.dataset.serviceValue = option.label;
      button.setAttribute("role", "option");
      button.setAttribute(
        "aria-selected",
        String(option.label === trigger.dataset.value),
      );
      const label = document.createElement("span");
      label.textContent = option.label;
      const check = document.createElement("span");
      check.className = "service-picker-check";
      check.setAttribute("aria-hidden", "true");
      check.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 13 4 4L19 7"/></svg>';
      button.append(label, check);
      return button;
    }),
  );
}

function populateServiceLevels(values = profileDraft().serviceLines) {
  if (!processLandscape) {
    for (const id of serviceLevelIds) {
      document.getElementById(id).disabled = true;
    }
    return;
  }

  let parent = null;
  let invalidSelection = false;
  const resolvedValues = [];

  serviceLevelIds.forEach((id, index) => {
    const trigger = document.getElementById(id);
    const options =
      index === 0
        ? completeProcessNodes(processLandscape, 1)
        : parent
          ? completeProcessNodes(parent.children, index + 1)
          : [];

    const requestedValue = invalidSelection ? "" : values[index] || "";
    const hasRequestedValue = options.some(
      (option) => option.label === requestedValue,
    );
    updateServiceTrigger(trigger, hasRequestedValue ? requestedValue : "");
    renderServicePickerOptions(trigger, options);
    trigger.disabled = options.length === 0;
    resolvedValues[index] = trigger.dataset.value;
    parent =
      options.find((option) => option.label === trigger.dataset.value) || null;

    if (requestedValue && !hasRequestedValue) invalidSelection = true;
  });

  profileDraft().serviceLines = resolvedValues;
  if (invalidSelection) {
    $("profileSaveStatus").textContent =
      "Saved service levels are no longer available. Please select them again.";
  }
}

function setProcessLandscape(tree) {
  const isNode = (node) =>
    node &&
    typeof node.label === "string" &&
    Array.isArray(node.children) &&
    node.children.every(isNode);
  if (
    !Array.isArray(tree) ||
    !tree.every(isNode) ||
    completeProcessNodes(tree, 1).length === 0
  ) {
    throw new Error("The process landscape data has an invalid format.");
  }

  processLandscape = tree;
  processLandscapeError = "";
  populateServiceLevels();
}

function setProcessLandscapeError(error) {
  processLandscapeError = String(error);
  if ($("drawer").open) {
    $("profileSaveStatus").textContent =
      "Could not load process landscape: " + processLandscapeError;
  }
}

// Profile 编辑内容在点击 Save 前都只是草稿；新 Flow 尚未持久化时先使用稳定生成的编号，
// 不要因此过早将它插入列表。
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
    // 每次保存推进一位版本号；首次保存归一为 v1.0.0。
    version = currentFlow?.version
      ? nextTaskVersion(currentFlow.version)
      : "v1.0.0";
  if (draft.versions.length)
    draft.versions[draft.versions.length - 1].name = version;
  else draft.versions.push({ name: version, enabled: false });
  const snapshot = {
    code,
    name: $("flowName").value.trim(),
    description: $("flowDescription").value.trim(),
    serviceLines: [...draft.serviceLines],
    versions: draft.versions.map((version) => ({ ...version })),
    enabled: draft.versions.some((version) => version.enabled),
    version,
    category: currentFlow?.category || "",
    status: currentFlow?.status || "Ready",
  };
  // 先从表单和草稿构造快照，避免未保存输入提前污染 flowData。
  if (currentFlow) Object.assign(currentFlow, snapshot);
  else {
    // 新任务仅在确认保存时创建正式列表项，并将草稿键迁移到生成的任务编号。
    currentFlow = snapshot;
    flowData.push(currentFlow);
    profileDrafts.set(code, draft);
    profileDrafts.delete("new");
    activeFlowKey = code;
  }
  // 编号仅展示为 Taskflow-001 形式；存储中的 code 保持 TASKFLOW-001 不变。
  $("drawerTitle").textContent = code.replace("TASKFLOW", "Taskflow");
  draft.name = snapshot.name;
  draft.description = snapshot.description;
  render();
  $("profileSaveStatus").textContent = "Saved.";
  closeDrawer();
}

// 草稿按 Flow 编号（或 "new"）分别保存，因此关闭并重新打开抽屉时仍可保留未保存的编辑，
// 同时不直接改动列表中已持久化的对象。
function profileDraft() {
  const key = currentFlow?.code || "new";
  // 仅在首次访问时从当前任务复制初值；之后的表单修改都留在独立草稿中。
  if (!profileDrafts.has(key))
    profileDrafts.set(key, {
      name: currentFlow?.name || "",
      description: currentFlow?.description || "",
      serviceLines: [...(currentFlow?.serviceLines || ["", "", "", ""])],
      versions: (
        currentFlow?.versions || [{ name: "v1.0.0", enabled: false }]
      ).map((version) => ({ ...version })),
    });
  return profileDrafts.get(key);
}

function renderVersionManagement() {
  const draft = profileDraft();
  $("versionManagementRows").replaceChildren(
    ...draft.versions.map((version, index) => {
      const row = rowTemplate("versionRowTemplate").cloneNode(true);
      const inputId = index === 0 ? "flowVersion" : "flowVersion" + index;
      const statusId = index === 0 ? "flowStatus" : "flowStatus" + index;
      row.querySelector("[data-version-label]").setAttribute("for", inputId);
      const input = row.querySelector("[data-version-input]");
      input.id = inputId;
      input.value = version.name;
      row.querySelector("[data-status-label]").setAttribute("for", statusId);
      const select = row.querySelector("[data-version-select]");
      select.id = statusId;
      select.dataset.versionIndex = index;
      select.setAttribute("aria-label", version.name + " status");
      select.value = version.enabled ? "Active" : "Deactive";
      return row;
    }),
  );
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

function render() {
  // 筛选只读取已提交的筛选值，不直接采用输入框中尚未应用的内容。
  // 每次渲染还会同步标签页的无障碍状态，并更新无匹配结果时的空列表提示。
  const rows = flowData.filter(
    (f) =>
      (!appliedSearch ||
        (f.code + " " + f.name + " " + f.description)
          .toLowerCase()
          .includes(appliedSearch)) &&
      (!appliedName || f.name.toLowerCase().includes(appliedName)) &&
      (!appliedVersion || f.version.toLowerCase().includes(appliedVersion)) &&
      (!appliedCategory || f.category === appliedCategory) &&
      (activeStatus === "All" ||
        (activeStatus === "Active" ? f.enabled : !f.enabled)),
  );
  // 显示列表只由已应用筛选条件决定；空结果仍保留一致的表格结构。
  $("flowRows").replaceChildren(
    ...(rows.length
      ? rows.map((f) => {
          const row = rowTemplate("flowRowTemplate").cloneNode(true);
          const codeLink = row.querySelector(".code-link");
          codeLink.href = "#" + f.code;
          codeLink.dataset.open = f.code;
          codeLink.textContent = f.code;
          row.querySelector('[data-slot="name"]').textContent = f.name;
          const description = row.querySelector(".flow-description");
          description.title = f.description;
          description.textContent = f.description;
          row.querySelector('[data-slot="version"]').textContent =
            taskVersionLabel(f);
          const status = row.querySelector(".flow-enabled");
          status.classList.add(f.enabled ? "active" : "deactive");
          row.querySelector('[data-slot="status"]').textContent = f.enabled
            ? "Active"
            : "Deactive";
          row.querySelectorAll("[data-action]").forEach((button) => {
            const name = button.dataset.action;
            button.dataset.code = f.code;
            button.setAttribute(
              "aria-label",
              name[0].toUpperCase() + name.slice(1) + " " + f.code,
            );
            button.disabled = flowRowActionDisabled(name, f);
          });
          return row;
        })
      : [rowTemplate("flowEmptyRowTemplate").cloneNode(true)]),
  );

  $("range").textContent = rows.length
  ? `1 - ${rows.length} of ${rows.length} items`
  : "0 - 0 of 0 items";

  $("currentPage").disabled = !rows.length;
  // 标签选择状态与键盘焦点顺序一并更新，避免筛选/重绘后仍指向旧标签。
  document.querySelectorAll("[data-status]").forEach((b) => {
    const active = b.dataset.status === activeStatus;
    b.setAttribute("aria-selected", String(active));
    b.tabIndex = active ? 0 : -1;
  });
}

function openDrawer(code, source) {
  // 显示模态框前先确定 Profile，并记录打开它的控件及页面滚动位置。
  // 新建 Flow 时只清理已经失去归属的临时录制状态，已创建 Flow 的会话互不影响。
  currentFlow = code ? flowData.find((f) => f.code === code) : null;
  trigger = source;
  savedScroll = window.scrollY;
  $("drawerTitle").textContent = (code || nextTaskflowCode()).replace(
    "TASKFLOW",
    "Taskflow",
  );
  $("profileSaveStatus").textContent = "";
  if (processLandscapeError) {
    $("profileSaveStatus").textContent =
      "Could not load process landscape: " + processLandscapeError;
  }
  
  if (!code) {
    profileDrafts.delete("new");
    // 清除上一个新建 Flow 会话遗留的临时 Design 状态。
    const orphanedNewCode = activeFlowKey;
    if (orphanedNewCode && !flowData.find((f) => f.code === orphanedNewCode)) {
      recordingSessions.delete(orphanedNewCode);
    }
    // initializeDrawerRecording 会为新 Flow 生成最终的 activeFlowKey。
  }
  
  const draft = profileDraft();
  // 每次打开都从对应草稿恢复输入，列表中的持久化对象不会被表单直接引用。
  $("flowName").value = draft.name;
  $("flowDescription").value = draft.description;
  initialName = draft.name;
  renderVersionManagement();
  
  populateServiceLevels(draft.serviceLines);
  closePopup("category");
  closePopup("service");
  closeServicePickers();
  initializeDrawerRecording(code);
  $("drawer").showModal();
  document.body.style.overflow = "hidden";
  $("flowName").focus({ preventScroll: true });
  if (code && typeof window.loadTaskDetails === "function") {
    void window.loadTaskDetails(code).catch((err) => {
      console.error("Could not load task details:", err);
    });
  }
}

async function closeDrawer() {
  // 录制过程中不能直接关闭模态框：先征求确认并完成录制，再保留草稿，
  // 最后关闭抽屉并恢复原有焦点和滚动位置。
  const session = recordingSession();
  if (session.stage === "recording") {
    if (!(await confirmWorkspaceAction("Stop recording and close?"))) return;
    await finishBrowserRecording();
  }
  const draft = profileDraft();
  draft.name = $("flowName").value;
  draft.description = $("flowDescription").value;
  closePopup("service");
  closeServicePickers();
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
  if (willOpen) {
    if (type === "category") {
      $("categorySearch").value = "";
      renderCategoryOptions();
    }
    $(type === "category" ? "categorySearch" : "serviceSearch").focus();
  }
}

// Category 仍为演示态：选项 = 演示种子 + 已保存任务里出现过的类别，保证下拉不为空。
const demoCategoryOptions = ["采购", "信息检索"];
function categoryOptionValues() {
  return [
    ...new Set([
      ...demoCategoryOptions,
      ...flowData.map((flow) => flow.category),
    ]),
  ].filter(Boolean);
}

function renderCategoryOptions() {
  const list = $("categoryOptions");
  if (!list) return;
  const query = ($("categorySearch").value || "").trim().toLowerCase();
  const options = categoryOptionValues().filter((option) =>
    option.toLowerCase().includes(query),
  );
  list.replaceChildren(
    ...options.map((option) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "popup-option";
      button.dataset.categoryOption = option;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(option === appliedCategory));
      button.textContent = option;
      return button;
    }),
  );
  if (!options.length) {
    const empty = document.createElement("p");
    empty.className = "popup-option-empty";
    empty.textContent = "No matching options";
    list.append(empty);
  }
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
  appliedCategory = "";
  activeStatus = "All";
  $("categoryValue").textContent = "Please select";
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
// 原生文件选择器取消时产生的 cancel 事件可能在选择器关闭后才异步到达（可能指向
// input 也可能指向抽屉本身）；三层防护：input 处截停冒泡、抽屉监听只响应直接
// 作用于自身的事件，并在打开选择器后短暂抑制，确保取消上传不会触发 Close 确认。
let suppressDrawerCancelUntil = 0;
$("drawer").addEventListener("cancel", (e) => {
  e.preventDefault();
  if (e.target !== e.currentTarget) return;
  if (Date.now() < suppressDrawerCancelUntil) return;
  closeDrawer();
});
$("category").onclick = () => togglePopup("category");
$("categorySearch").oninput = () => renderCategoryOptions();
$("categoryOptions").onclick = (e) => {
  const option = e.target.closest("[data-category-option]");
  if (!option) return;
  const value = option.dataset.categoryOption;
  // 再次点击已选中的类别 = 取消筛选。
  appliedCategory = appliedCategory === value ? "" : value;
  $("categoryValue").textContent = appliedCategory || "Please select";
  closePopup("category");
  render();
  updateFilterExpansion();
};

$("categorySearch").onkeydown = (e) => {
  if (e.key !== "Escape") return;
  e.preventDefault();
  e.stopPropagation();
  closePopup("category");
  $("category").focus();
};

function closeServicePicker(trigger) {
  const popup = servicePickerPopup(trigger);
  if (popup) popup.hidden = true;
  trigger.setAttribute("aria-expanded", "false");
}

function closeServicePickers() {
  document
    .querySelectorAll(".service-picker-trigger[aria-expanded='true']")
    .forEach(closeServicePicker);
}

function filterServicePickerOptions(trigger) {
  const popup = servicePickerPopup(trigger);
  if (!popup) return;
  const query = popup
    .querySelector("input[type=search]")
    .value.trim()
    .toLowerCase();
  let visible = 0;
  popup.querySelectorAll(".service-picker-option").forEach((option) => {
    const match = option.dataset.serviceValue.toLowerCase().includes(query);
    option.hidden = !match;
    if (match) visible++;
  });
  const list = popup.querySelector(".service-picker-options");
  const total = list.querySelectorAll(".service-picker-option").length;
  let empty = list.querySelector(".service-picker-empty");
  if (visible) {
    empty?.remove();
    return;
  }
  if (!empty) {
    empty = document.createElement("p");
    empty.className = "service-picker-empty";
    list.append(empty);
  }
  empty.textContent = total ? "No matching options" : "No options available";
}

document.querySelectorAll(".service-picker-trigger").forEach((trigger) => {
  const popup = servicePickerPopup(trigger);
  if (!popup) return;
  const search = popup.querySelector("input[type=search]");
  const clearButton = popup.querySelector("button");
  const list = popup.querySelector(".service-picker-options");

  trigger.onclick = () => {
    if (trigger.disabled) return;
    const opening = popup.hidden;
    closeServicePickers();
    if (!opening) return;
    search.value = "";
    filterServicePickerOptions(trigger);
    popup.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    search.focus();
  };
  search.oninput = () => filterServicePickerOptions(trigger);
  search.onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      return;
    }
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    if (search.value) {
      search.value = "";
      filterServicePickerOptions(trigger);
    } else {
      closeServicePicker(trigger);
      trigger.focus();
    }
  };
  popup.onkeydown = (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    closeServicePicker(trigger);
    trigger.focus();
  };
  clearButton.onclick = () => {
    search.value = "";
    filterServicePickerOptions(trigger);
    search.focus();
  };
  list.onclick = (e) => {
    const option = e.target.closest("[data-service-value]");
    if (!option) return;
    const index = Number(trigger.dataset.serviceIndex);
    const values = serviceLevelIds.map(
      (id) => document.getElementById(id).dataset.value || "",
    );
    values[index] = option.dataset.serviceValue;
    values.fill("", index + 1);
    closeServicePickers();
    populateServiceLevels(values);
    $("profileSaveStatus").textContent = "";
    trigger.focus();
  };
});

document.addEventListener("click", (e) => {
  if (!e.target.closest("#categoryField")) closePopup("category");
  if (!e.target.closest(".form-select")) closePopup("service");
  if (!e.target.closest(".service-line-control")) closeServicePickers();
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
  let missing = false;
  for (const trigger of document.querySelectorAll(".service-picker-trigger")) {
    const empty = !trigger.disabled && !trigger.dataset.value;
    trigger.setAttribute("aria-invalid", String(empty));
    if (empty) missing = true;
  }
  if (missing) {
    $("profileSaveStatus").textContent = "Please complete all service levels.";
    return false;
  }
  return true;
}

// 独立嵌入式演示内容。这里的本地路由刻意放在 sandbox iframe 中渲染；
// preload API 可用时，bridge.js 会用 Electron 原生浏览器替换此模拟界面。
function embeddedBrowserHTML(route) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;background:#f7f8fa;font:14px Arial,'Microsoft YaHei',sans-serif;color:#111}button,input,select{font:inherit}header{height:46px;background:#005078;color:#fff;display:flex;align-items:center;justify-content:space-between;padding:0 14px;font-size:14px;font-weight:bold}header span{font-size:11px;font-weight:normal}nav{height:40px;background:#fff;display:flex;padding:0 14px;gap:16px;border-bottom:1px solid #dde3ea}nav button{border:0;background:none;color:#6d7d89;padding:0 6px;position:relative}nav button.active{color:#0084ce;border-bottom:2px solid #0084ce}main{padding:14px}.company{display:flex;align-items:center;gap:14px;margin-bottom:14px}.avatar{width:40px;height:40px;background:#e3f5ff;color:#0093d7;display:flex;align-items:center;justify-content:center;font-size:20px}h1{font-size:14px;margin:3px 0;font-weight:700}.company p{font-size:10px;color:#73828d;margin:5px 0}section{background:#fff;border:1px solid #dce3eb;padding:14px;margin-bottom:7px}h2{font-size:14px;margin:0 0 15px}dl{display:grid;grid-template-columns:34% 66%;gap:12px 8px;margin:0}dt{color:#788893}dd{margin:0}.saved{float:right;color:#07945d;font-size:12px}input,select{width:100%;height:30px;border:1px solid #d8dfe8;padding:3px 6px;background:white}.button{border:1px solid #007bc0;color:#007bc0;background:white;padding:6px 14px;margin-top:14px}</style></head><body><header>Indirect Procurement Workbench<span>Demo</span></header><nav>${["Suppliers", "Draft", "Receipts"].map((v) => `<button data-route="${v.toLowerCase()}" class="${route === v.toLowerCase() ? "active" : ""}">${v}</button>`).join("")}</nav><main>${route === "suppliers" ? `<div class="company"><div class="avatar">A</div><div><h1>安达设施服务（虚构）</h1><p>DEMO-V001 · Indirect Procurement / Facility Services</p></div></div><section><h2>Supplier master data</h2><dl><dt>Country / Currency</dt><dd>China / CNY</dd><dt>Purchasing contact</dt><dd>Supplier A · Demo contact</dd><dt>Supplier rating</dt><dd>B · Verified</dd><dt>Annual quotation</dt><dd>264,000.00</dd><dt>Total amount</dt><dd>292560</dd><dt>Delivery / SLA</dt><dd>12 days / 24-hour response</dd></dl></section><section><span class="saved">Saved</span><h2>Requirement draft</h2><dl><dt>Title</dt><dd>苏州示范工厂 2027 年度设施维护服务</dd><dt>Service date</dt><dd>2027-01-01</dd></dl></section>` : route === "draft" ? `<section><h2>Requirement draft</h2><dl><dt>Title</dt><dd><input value="苏州示范工厂 2027 年度设施维护服务" aria-label="Title"></dd><dt>Service date</dt><dd><input value="2027-01-01" aria-label="Service date" type="date"></dd><dt>Total amount</dt><dd><input value="292560" aria-label="Total amount"></dd></dl></section>` : `<section><h2>Receipts</h2></section>`}</main><script>document.addEventListener('click',e=>{const b=e.target.closest('[data-route]');if(b)parent.postMessage({type:'flowlink-route',route:b.dataset.route},'*');});document.addEventListener('input',e=>{if(e.target.matches('input,select'))parent.postMessage({type:'flowlink-input',target:e.target.getAttribute('aria-label'),value:e.target.value},'*');});<\/script><\/body><\/html>`;
}
// 节点变更和破坏性操作共用此确认步骤；Record 则会立即开始。
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
// 浏览器标签页彼此独立保留；一次录制可以覆盖期间使用的所有标签页。
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
    export: "M12 3v12m0 0 5-5m-5 5-5-5M4 17v4h16v-4",
  };
  return `<svg class="design-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${paths[name] || ""}"/></svg>`;
}

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
/** 操作类型 → 展示文本映射：无 label 的步骤按此合成可读文本（如 REFINED 的步骤已有业务语言 label 则优先用 label） */
const STEP_KIND_TEXT = {
  navigate: "打开页面",
  click: "点击",
  input: "填写",
  select: "选择",
  upload: "上传",
  hover: "悬停",
  key: "按键",
  scroll: "滚动",
  drag: "拖拽",
  wait: "等待",
  assert: "校验",
  condition: "条件判断",
  extract: "提取",
  dialog: "处理弹窗",
  openTab: "打开标签页",
  switchTab: "切换标签页",
  closeTab: "关闭标签页",
  script: "执行脚本",
};

function testStepLabel(step, index) {
  if (!step) return `Step ${index + 1}`;
  if (step.label?.trim()) return step.label.trim();
  if (step.text?.trim()) return step.text.trim();
  const kindText = STEP_KIND_TEXT[step.kind] || step.kind || "操作";
  const target = step.target?.candidates?.[0]?.value;
  const targetText =
    typeof target === "string" ? target : target?.name || target?.role || "";
  const extra = step.url ? step.url : step.value || targetText || "";
  return `${kindText}${extra ? ` · ${String(extra).replace(/^(?:https?:\/\/)/, "")}` : ""}`;
}

function testStepNode(step, index, result) {
  const status = result?.status || "pending";
  const label =
    status === "pass"
      ? "Passed"
      : status === "fail"
        ? "Failed"
        : status === "running"
          ? "Running"
          : status === "skip"
            ? "Skipped"
            : "Pending";
  const node = rowTemplate("testStepTemplate").cloneNode(true);
  node.classList.add("status-" + status);
  const icon = node.querySelector(".test-step-icon");
  icon.classList.add("status-" + status);
  icon.setAttribute("aria-label", label);
  icon.querySelectorAll("[data-status-icon]").forEach((svg) => {
    setIconHidden(svg, svg.dataset.statusIcon !== status);
  });
  node.querySelector(".test-step-name").textContent =
    typeof step === "string" ? step : testStepLabel(step, index);
  const aiBadge = node.querySelector(".test-step-ai");
  if (aiBadge) aiBadge.hidden = !result?.ai;
  node.querySelector(".test-step-status").textContent = label;
  const error = node.querySelector(".test-step-error");
  error.hidden = !result?.error?.message;
  if (result?.error?.message) error.textContent = result.error.message;
  return node;
}

function resetTestExecutionStatus(item) {
  if (!item) return;
  const steps = item.testFlowSteps?.length
    ? item.testFlowSteps
    : item.steps || [];
  item.testRunning = false;
  item.testResults = steps.map(() => ({ status: "pending" }));
}

/**
 * Test 进度列表按组分节：与 Process 图上的组一一对应。
 * 分组依据 flattenedStepId 前缀（顶层组 id；无前缀的连续裸步骤归入"未分组"节）；
 * 名称/编号优先取 ensureProcessGroups 视图（processFlow 已加载时）。
 */
function testProgressGroups(item) {
  const steps = item.testFlowSteps?.length
    ? item.testFlowSteps
    : item.steps || [];
  const labelById = new Map();
  if (item.processFlow) {
    for (const group of ensureProcessGroups(item)) labelById.set(group.id, group);
  }
  const sections = [];
  let current = null;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const flatId = step?.flattenedStepId || step?.id || String(i);
    const groupId = flatId.includes("/") ? flatId.split("/")[0] : "";
    const key = groupId || "__ungrouped__";
    if (!current || current.key !== key) {
      const view = labelById.get(groupId);
      current = {
        key,
        rows: [],
        number: view?.number || "",
        name: view?.name || groupId || "未分组步骤",
      };
      sections.push(current);
    }
    current.rows.push({ step, index: i, result: (item.testResults || [])[i] });
  }
  return sections;
}

/** 组节聚合状态：fail > running > pass > 全跳过（分支未走） > pending */
function testGroupStatus(rows) {
  let fail = false;
  let running = false;
  let pass = false;
  let skipped = 0;
  for (const row of rows) {
    const status = row.result?.status || "pending";
    if (status === "fail") fail = true;
    else if (status === "running") running = true;
    else if (status === "pass") pass = true;
    else if (status === "skip") skipped++;
  }
  if (fail) return "fail";
  if (running) return "running";
  if (pass) return "pass";
  if (rows.length && skipped === rows.length) return "skipped";
  return "pending";
}

// 结果面板的静态分区已由 recordingLayoutTemplate 提供；这里按标签页填充数据。
function fillResultPanel(panel, active, item) {
  panel.querySelectorAll("[data-result-tab]").forEach((section) => {
    section.hidden = section.dataset.resultTab !== active;
  });
  if (active === "Process") fillProcessPanel(panel, item);
  else if (active === "Instruction") fillInstructionPanel(panel, item);
  else if (active === "Reference") fillReferencePanel(panel, item);
  else if (active === "Metric") fillMetricPanel(panel);
  else if (active === "Record") fillRecordPanel(panel, item);
}

function canvasStepNode(group, text, index, refinedFlow, result) {
  const step = rowTemplate("canvasStepTemplate").cloneNode(true);
  step.dataset.canvasStepIndex = group.start + index;
  step.querySelector("[data-step-code]").textContent =
    group.number + "-" + String(index + 1).padStart(3, "0");
  step.querySelector("[data-step-text]").textContent = text;
  // 徽标表达步骤来源：REFINED 流程的步骤默认 Automation（AI 细化生成）；
  // 原始录制的步骤默认 Manual（人工录制）；用户在编辑器新增的步骤（manual_ 前缀
  // id）与显式标 execution: manual 的步骤始终 Manual。execution 字段的回放语义
  // （暂停等人工确认）不受此展示逻辑影响。
  const flowStep = group.flowSteps?.[index];
  // 条件分支步骤：加 class 供样式区分（虚线边框），让分支决策点在串行组卡里可辨识。
  if (flowStep?.kind === "condition") step.classList.add("condition-step");
  const manual =
    flowStep?.execution === "manual" ||
    String(flowStep?.id || "").startsWith("manual_") ||
    !refinedFlow;
  const icon = step.querySelector(".execution-mode-icon");
  icon.setAttribute("aria-label", manual ? "Manual" : "Automated");
  icon.title = manual ? "Manual" : "Automated";
  setIconHidden(icon.querySelector('[data-mode-icon="automated"]'), manual);
  setIconHidden(icon.querySelector('[data-mode-icon="manual"]'), !manual);
  // 回放态叠加：步骤行状态点 + 结果 chip + AI 徽标（运行时数据，允许 JS 生成）
  if (result && result.status && result.status !== "pending") {
    step.classList.add("status-" + result.status);
    const dot = document.createElement("span");
    dot.className = "canvas-step-dot";
    step.prepend(dot);
    const chip = document.createElement("span");
    chip.className = "canvas-step-chip";
    chip.dataset.chipStatus = result.status;
    chip.textContent =
      result.status === "pass"
        ? "✓"
        : result.status === "fail"
          ? "✗"
          : result.status === "running"
            ? "…"
            : "跳过";
    step.append(chip);
    if (result.ai) {
      const ai = document.createElement("span");
      ai.className = "canvas-step-ai";
      ai.textContent = "AI";
      ai.title = "AI takeover completed this step";
      step.append(ai);
    }
  }
  return step;
}

/** Process 图：来源配色（多来源时按 meta.sourceFlows 顺序取色） */
const PROCESS_SOURCE_COLORS = [
  "#00884a",
  "#1e60c7",
  "#c77c1e",
  "#7a4fc9",
  "#0f8a8a",
];

/** 图节点 → 渲染视图：真实组走 ensureProcessGroups 视图（切分卡经 groupId 指回原组）；未分组伪组现做 */
function graphNodeView(node, entries, viewByGroupId) {
  if (node.type === "group") return viewByGroupId.get(node.groupId || node.id) || null;
  if (node.type === "ungrouped") {
    const flowSteps = [];
    for (let i = node.firstIndex; i < node.lastIndex; i++)
      flowSteps.push(entries[i]?.step);
    return {
      id: node.id,
      name: "未分组步骤",
      label: "未分组步骤",
      index: -1,
      start: node.firstIndex,
      count: flowSteps.length,
      number: "—",
      tab: 1,
      url: "",
      flowSteps,
      branchEntries: [],
      steps: flowSteps.map((step, i) => processStepLabel(step, i)),
    };
  }
  return null;
}

/** 组卡聚合状态：有失败=红 / 全跳过=灰 / 有通过或运行中=绿，其余不描边 */
function graphNodeResultStatus(node, entries, resultByStepId) {
  let pass = false;
  let fail = false;
  let running = false;
  let seen = 0;
  let skipped = 0;
  for (let i = node.firstIndex; i < node.lastIndex; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const result = resultByStepId.get(entry.flattenedStepId);
    if (!result || !result.status || result.status === "pending") continue;
    seen++;
    if (result.status === "fail") fail = true;
    else if (result.status === "running") running = true;
    else if (result.status === "skip") skipped++;
    else pass = true;
  }
  if (!seen) return "";
  if (fail) return "fail";
  if (running || pass) return "pass";
  if (skipped) return "skip";
  return "";
}

/** 边目标是否"被进入"（有任一步骤 pass/fail/running）；哨节点由调用方特判 */
function graphNodeEntered(node, entries, resultByStepId) {
  for (let i = node.firstIndex; i < node.lastIndex; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const result = resultByStepId.get(entry.flattenedStepId);
    if (result && (result.status === "pass" || result.status === "fail" || result.status === "running"))
      return true;
  }
  return false;
}

/**
 * SVG 边层：dagre 坐标已写回节点后调用。走过的路径边高亮、未走的分支边
 * 淡化虚线（仅在有回放结果时叠加；分支标签附"已走/未走"）。
 */
function drawProcessGraphEdges(svg, world, graph, overlay) {
  const NS = "http://www.w3.org/2000/svg";
  svg.setAttribute("width", String(Math.max(1, graph.worldWidth)));
  svg.setAttribute("height", String(Math.max(1, graph.worldHeight)));
  svg.setAttribute(
    "viewBox",
    `0 0 ${Math.max(1, graph.worldWidth)} ${Math.max(1, graph.worldHeight)}`,
  );
  svg.replaceChildren();
  const defs = document.createElementNS(NS, "defs");
  for (const [id, color] of [
    ["edge-arrow", "#7d8a92"],
    ["edge-arrow-taken", "#00884a"],
    ["edge-arrow-dim", "#c3cbd1"],
  ]) {
    const marker = document.createElementNS(NS, "marker");
    marker.setAttribute("id", id);
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "9");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "7");
    marker.setAttribute("markerHeight", "7");
    marker.setAttribute("orient", "auto-start-reverse");
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", "M0,0 L10,5 L0,10 z");
    path.setAttribute("fill", color);
    marker.appendChild(path);
    defs.appendChild(marker);
  }
  svg.appendChild(defs);

  // —— 折线边（dagre 路由点）：起/终点锚定到节点边界，中间拐点原样连线 ——
  // 判断节点取菱形顶点（出向一向下一向侧，贴近标准流程图画法），
  // 矩形节点取中心连线与边框的交点；允许斜向与转弯线段。
  const rectBoundary = (node, toward) => {
    const dx = toward.x - node.cx;
    const dy = toward.y - node.cy;
    if (!dx && !dy) return { x: node.cx, y: node.cy + node.height / 2 };
    const scale = Math.min(
      dx ? node.width / 2 / Math.abs(dx) : Infinity,
      dy ? node.height / 2 / Math.abs(dy) : Infinity,
    );
    return { x: node.cx + dx * scale, y: node.cy + dy * scale };
  };
  const decisionVertex = (node, toward) => {
    const dx = toward.x - node.cx;
    const dy = toward.y - node.cy;
    if (Math.abs(dy) >= Math.abs(dx))
      return {
        x: node.cx,
        y: node.cy + (dy >= 0 ? node.height / 2 : -node.height / 2),
      };
    return {
      x: node.cx + (dx >= 0 ? node.width / 2 : -node.width / 2),
      y: node.cy,
    };
  };
  const forwardEdge = (edge, from, to) =>
    Array.isArray(edge.points) &&
    edge.points.length >= 2 &&
    edge.kind !== "back" &&
    to.cy > from.cy;
  // 判断节点两个前向分支的出向分配：横向偏移更大的走侧顶点（右/左），
  // 更垂直的走底顶点；持平则“是”向下、“否”向右。
  const decisionExit = new Map();
  for (const node of graph.nodes) {
    if (node.type !== "decision") continue;
    const out = graph.edges.filter((edge) => {
      if (edge.from !== node.id) return false;
      const target = graph.nodeById.get(edge.to);
      return !!target && forwardEdge(edge, node, target);
    });
    if (out.length !== 2) continue;
    const lateralOf = (edge) =>
      Math.abs((graph.nodeById.get(edge.to)?.cx ?? node.cx) - node.cx);
    const [first, second] = out;
    const lateral =
      lateralOf(first) > lateralOf(second)
        ? first
        : lateralOf(second) > lateralOf(first)
          ? second
          : first.branch === "false"
            ? first
            : second;
    for (const edge of out) {
      if (edge !== lateral) decisionExit.set(edge, "down");
      else {
        const dx = (graph.nodeById.get(edge.to)?.cx ?? node.cx) - node.cx;
        decisionExit.set(edge, dx >= 0 ? "right" : "left");
      }
    }
  }

  const labels = [];
  for (const edge of graph.edges) {
    const from = graph.nodeById.get(edge.from);
    const to = graph.nodeById.get(edge.to);
    if (!from || !to || from.cx === undefined || to.cx === undefined) continue;
    let d;
    let labelAt;
    if (forwardEdge(edge, from, to)) {
      const inner = edge.points.slice(1, -1);
      const firstToward = inner[0] || edge.points[edge.points.length - 1];
      const lastToward = inner[inner.length - 1] || edge.points[0];
      let src;
      if (from.type === "decision") {
        const hint = decisionExit.get(edge);
        src =
          hint === "right"
            ? { x: from.cx + from.width / 2, y: from.cy }
            : hint === "left"
              ? { x: from.cx - from.width / 2, y: from.cy }
              : { x: from.cx, y: from.cy + from.height / 2 };
      } else {
        src = rectBoundary(from, firstToward);
      }
      const dst =
        to.type === "decision"
          ? decisionVertex(to, lastToward)
          : rectBoundary(to, lastToward);
      const pts = [src, ...inner, dst];
      d =
        `M ${pts[0].x} ${pts[0].y} ` +
        pts
          .slice(1)
          .map((p) => `L ${p.x} ${p.y}`)
          .join(" ");
      const after = inner[0] || dst;
      labelAt = { x: (src.x + after.x) / 2, y: (src.y + after.y) / 2 };
    } else if (edge.kind === "back" || to.cy <= from.cy) {
      // 回跳/同层：从源右缘绕到目标右缘的外弓虚线
      const x1 = from.cx + from.width / 2;
      const y1 = from.cy;
      const x2 = to.cx + to.width / 2;
      const y2 = to.cy;
      const bow = 72 + Math.abs(x1 - x2) * 0.25;
      d = `M ${x1} ${y1} C ${x1 + bow} ${y1}, ${x2 + bow} ${y2}, ${x2} ${y2}`;
      labelAt = { x: Math.max(x1, x2) + bow * 0.55, y: (y1 + y2) / 2 };
    } else {
      const sx = from.cx;
      const sy = from.cy + from.height / 2;
      const tx = to.cx;
      const ty = to.cy - to.height / 2;
      const mid = Math.max(24, (ty - sy) * 0.45);
      d = `M ${sx} ${sy} C ${sx} ${sy + mid}, ${tx} ${ty - mid}, ${tx} ${ty}`;
      labelAt = { x: (sx + tx) / 2, y: (sy + ty) / 2 };
    }

    // 回放态：目标被进入 → 高亮；运行结束仍未走 → 淡化虚线
    let stateClass = "";
    let suffix = "";
    if (overlay.hasResults) {
      const entered =
        to.type === "end"
          ? overlay.runFinished && graphNodeEntered(from, graph.entries, overlay.resultByStepId)
          : graphNodeEntered(to, graph.entries, overlay.resultByStepId);
      if (entered) {
        stateClass = " taken";
        suffix = " · 已走";
      } else if (overlay.runFinished || to.type !== "end") {
        stateClass = " dim";
        suffix = " · 未走";
      }
    }

    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("class", `process-edge${edge.kind === "back" ? " back" : ""}${stateClass}`);
    path.setAttribute(
      "marker-end",
      `url(#edge-arrow${stateClass === " taken" ? "-taken" : stateClass === " dim" ? "-dim" : ""})`,
    );
    svg.appendChild(path);

    if (edge.label) {
      const label = document.createElement("div");
      label.className =
        "process-edge-label" +
        (edge.branch === "false" ? " no" : "") +
        (stateClass === " dim" ? " dim" : "");
      label.textContent = edge.label + (overlay.hasResults ? suffix : "");
      label.style.left = labelAt.x + "px";
      label.style.top = labelAt.y + "px";
      labels.push(label);
    }
  }
  // 标签挂在 world 下（随平移缩放走），在卡片之下由 z-order 保证
  for (const label of labels) world.appendChild(label);
}

function fillProcessPanel(panel, item) {
  const canvas = panel.querySelector(".process-canvas");
  canvas.querySelector(".process-canvas-world").hidden = false;
  canvas.querySelector(".canvas-view-controls").hidden = false;
  canvas.querySelector(".process-status:not(.error)").hidden =
    !item?.processFlowLoading;
  const error = canvas.querySelector(".process-status.error");
  error.hidden = !item?.processFlowError;
  if (item?.processFlowError) error.textContent = item.processFlowError;
  const world = canvas.querySelector(".process-canvas-world");
  const groups = item ? ensureProcessGroups(item) : [];
  const flow = item?.processFlow;

  // 图模式依赖 dagre（vendor 脚本）：缺失时显示明确错误而非白屏；不提供串行回退。
  if ((flow || groups.length) && !window.__flowlinkDagre) {
    error.hidden = false;
    error.textContent =
      "Process 流程图布局引擎未加载（dist/renderer-vendor.js 缺失或未构建）。请先运行 npm run build，再重启应用。";
  }

  // 回放态数据源：testResults 与 testFlowSteps 按下标对齐，再按 stepId 建映射
  const resultByStepId = new Map();
  const hasResults =
    !!item?.testFlowSteps?.length && Array.isArray(item.testResults);
  if (hasResults) {
    for (let i = 0; i < item.testFlowSteps.length; i++) {
      const step = item.testFlowSteps[i];
      const result = item.testResults[i];
      if (step?.flattenedStepId && result?.status && result.status !== "pending")
        resultByStepId.set(step.flattenedStepId, result);
    }
  }

  // —— 图模型（真实 Flow；演示数据合成为同构模型走同一渲染管线） ——
  let graph = null;
  if (flow) {
    graph = FlowGraph.buildGraph(flow);
  } else if (groups.length) {
    graph = FlowGraph.buildGraph({
      steps: groups.map((group) => ({
        kind: "group",
        id: group.id,
        label: group.name,
        steps: group.flowSteps?.length
          ? group.flowSteps
          : Array.from({ length: group.count || 0 }, (_, i) => ({
              kind: "demo",
              id: `${group.id}-demo-${i}`,
            })),
      })),
    });
  }

  // —— 1. 先渲染卡片（组卡 DOM 复用：徽标/条件样式/点击/右键全保留） ——
  const viewByGroupId = new Map(groups.map((group) => [group.id, group]));
  const elements = new Map(); // node.id → DOM（卡片或哨节点）
  const children = [];
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  // SVGElement.className 只有 getter，必须用 setAttribute（赋值会抛 TypeError
  // 并把 renderSummaryWorkspace 从 fillProcessPanel 中间打断：AI 面板不再刷新、Process 空白）。
  svg.setAttribute("class", "process-graph-edges");
  children.push(svg);

  // 来源着色：多来源时按 sourceFlowId 分配色板下标
  const sourceOrder = [];
  if (graph && flow?.meta?.sourceFlows?.length) {
    for (const node of graph.nodes) {
      if (
        (node.type === "group" || node.type === "ungrouped") &&
        node.sourceFlowId &&
        !sourceOrder.includes(node.sourceFlowId)
      )
        sourceOrder.push(node.sourceFlowId);
    }
  }
  const sourceMetaById = new Map(
    (flow?.meta?.sourceFlows || []).map((source) => [source.flowId, source]),
  );

  if (graph) {
    for (const node of graph.nodes) {
      if (node.type === "start" || node.type === "end") {
        const sentinel = document.createElement("div");
        sentinel.className =
          "process-sentinel" + (node.type === "end" ? " end" : "");
        sentinel.dataset.sentinelNode = node.id;
        sentinel.textContent = node.label;
        children.push(sentinel);
        elements.set(node.id, sentinel);
        continue;
      }
      if (node.type === "decision") {
        // 判断节点（菱形）：契约形态的组尾 condition 提取为独立节点，
        // 连接两个出向组；组卡不再重复显示该步骤行。
        const decision = document.createElement("div");
        decision.className = "process-decision";
        decision.dataset.decisionNode = node.id;
        decision.title = node.label;
        const text = document.createElement("span");
        text.textContent = node.label;
        decision.appendChild(text);
        const decisionStatus = graphNodeResultStatus(
          node,
          graph.entries,
          resultByStepId,
        );
        if (decisionStatus) decision.classList.add("result-" + decisionStatus);
        children.push(decision);
        elements.set(node.id, decision);
        continue;
      }
      const view = graphNodeView(node, graph.entries, viewByGroupId);
      if (!view) continue;
      const section = rowTemplate("canvasGroupCardTemplate").cloneNode(true);
      const groupKey = node.groupId || node.id;
      const selected = item.selectedGroup === groupKey;
      section.dataset.canvasGroup = groupKey;
      section.classList.toggle("selected", selected);
      const icon = section.querySelector(".canvas-group-icon");
      icon.src = groupFaviconUrl(view.url);
      icon.onerror = () => {
        icon.src = genericGroupIcon;
        icon.onerror = null;
      };
      const heading = section.querySelector(".canvas-group-heading");
      heading.dataset.groupSelect = groupKey;
      heading.setAttribute("aria-pressed", String(selected));
      heading.textContent = view.number + " · " + view.name;
      // 分支徽标：该组是某个 condition 的 true/false 目标时说明"何时执行"。
      const branchEntries = view.branchEntries || [];
      const branchBadge = section.querySelector(".canvas-group-branch");
      branchBadge.hidden = branchEntries.length === 0;
      if (branchEntries.length) {
        section.classList.add("branch-target");
        branchBadge.textContent =
          "分支 · " +
          branchEntries
            .map(
              (entry) =>
                `当「${entry.conditionLabel}」为 ${entry.whenTrue ? "是" : "否"} 时执行`,
            )
            .join("；");
      }
      // 来源着色（单来源 = 录制原色不动；多来源 = 按来源上色 + 图例）
      if (sourceOrder.length > 1 && node.sourceFlowId) {
        const colorIndex = sourceOrder.indexOf(node.sourceFlowId);
        if (colorIndex >= 0) {
          section.classList.add("has-source");
          section.style.borderColor =
            PROCESS_SOURCE_COLORS[colorIndex % PROCESS_SOURCE_COLORS.length];
        }
      }
      // 回放态：组卡结果描边（全过=绿、有失败=红、全跳过=灰）
      const nodeStatus = graphNodeResultStatus(node, graph.entries, resultByStepId);
      if (nodeStatus) section.classList.add("result-" + nodeStatus);
      // 组卡行区间对齐：切分卡只显示 [firstIndex, lastIndex) 覆盖的行
      //（view.start 为组首行绝对下标；嵌套组行按旧近似处理）。
      const rowOffset = Math.max(0, node.firstIndex - (view.start || 0));
      section.querySelector(".canvas-group-nodes").replaceChildren(
        ...(view.steps.length
          ? view.steps
              .slice(
                Math.min(rowOffset, view.steps.length),
                Math.min(
                  rowOffset + Math.max(0, node.lastIndex - node.firstIndex),
                  view.steps.length,
                ),
              )
              .map((text, index) =>
                // 步骤行状态：flowStep 与 graph.entries 中的是同一对象引用，
                // 展平时已标注 flattenedStepId（嵌套 group 行无标注，跳过状态叠加）
                canvasStepNode(
                  view,
                  text,
                  rowOffset + index,
                  item.summary === true,
                  resultByStepId.get(
                    view.flowSteps?.[rowOffset + index]?.flattenedStepId,
                  ),
                ),
              )
          : [rowTemplate("canvasEmptyStepTemplate").cloneNode(true)]),
      );
      children.push(section);
      elements.set(node.id, section);
    }
  }
  world.replaceChildren(...children);

  // —— 2/3. dagre 布局（先量卡片尺寸）→ 绝对定位 ——
  if (graph && graph.nodes.length) {
    const laid = FlowGraph.layoutGraph(graph, (node) => {
      const el = elements.get(node.id);
      return el ? { width: el.offsetWidth, height: el.offsetHeight } : undefined;
    });
    if (laid) {
      for (const node of graph.nodes) {
        const el = elements.get(node.id);
        if (!el || node.left === undefined) continue;
        el.style.left = node.left + "px";
        el.style.top = node.top + "px";
      }
      world.style.width = Math.max(1, graph.worldWidth) + "px";
      world.style.height = Math.max(1, graph.worldHeight) + "px";
      // —— 4. 画边层（含回放态叠加） ——
      drawProcessGraphEdges(svg, world, graph, {
        resultByStepId,
        hasResults,
        runFinished: hasResults && !item?.testRunning,
      });
    } else {
      world.style.width = "";
      world.style.height = "";
    }
  } else {
    world.style.width = "";
    world.style.height = "";
  }

  // 来源图例（画布层固定悬浮，不随平移缩放）
  canvas.querySelectorAll(".process-source-legend").forEach((node) => node.remove());
  if (sourceOrder.length > 1) {
    const legend = document.createElement("div");
    legend.className = "process-source-legend";
    for (const flowId of sourceOrder) {
      const meta = sourceMetaById.get(flowId);
      const entry = document.createElement("span");
      entry.className = "process-source-item";
      const swatch = document.createElement("i");
      swatch.className = "process-source-swatch";
      swatch.style.background =
        PROCESS_SOURCE_COLORS[sourceOrder.indexOf(flowId) % PROCESS_SOURCE_COLORS.length];
      entry.appendChild(swatch);
      entry.appendChild(
        document.createTextNode(meta?.title || flowId),
      );
      legend.appendChild(entry);
    }
    canvas.appendChild(legend);
  }

  canvas.querySelectorAll("[data-group-actions]").forEach((node) => node.remove());
  const menu = canvas.querySelector(".canvas-step-menu");
  // 按钮永不「无解释地变灰」：Flow 未加载 / 录制进行中 / 回放运行中都给出原因。
  const flowReady = Boolean(item.processFlow);
  const recordingNow = recordingSession().stage === "recording";
  const playbackActive =
    !!item.testRunning || recordingSession().playbackInFlight === true;
  const editBlockedReason = !flowReady
    ? item.processFlowError
      ? "The recorded Flow could not be loaded for this item."
      : "Loading the recorded Flow…"
    : recordingNow
      ? "Stop the recording to edit steps and groups."
      : playbackActive
        ? "Stop the running replay to edit steps and groups."
        : "";
  for (const [groupIndex, group] of groups.entries()) {
    const actions = rowTemplate("processGroupActionsTemplate").cloneNode(true);
    actions.dataset.groupActions = group.id;
    actions.hidden = item.selectedGroup !== group.id;
    const setEditState = (button, extraReason = "") => {
      // 模板可能隐藏部分操作按钮（当前 Add step / Add after / Rename / Move / Merge
      // 被注释掉）：接线必须容忍按钮缺失。此前在 null.dataset 上直接抛错，会把
      // renderSummaryWorkspace 从 fillProcessPanel 中间打断——bindProcessMap
      // （画布居中/缩放）不再执行、AI 面板不再刷新，后续每次重渲染都在同一点
      // 抛错，整个结果面板表现为卡死。
      if (!button) return;
      const reason = editBlockedReason || extraReason;
      button.disabled = Boolean(reason);
      button.title = reason;
    };
    const addStep = actions.querySelector("[data-group-add-step]");
    if (addStep) addStep.dataset.groupAddStep = group.id;
    setEditState(addStep);
    const addAfter = actions.querySelector("[data-group-add-after]");
    if (addAfter) addAfter.dataset.groupAddAfter = group.id;
    setEditState(addAfter);
    setEditState(actions.querySelector("[data-group-rename]"));
    setEditState(
      actions.querySelector('[data-group-move="up"]'),
      groupIndex === 0 ? "This is already the first group." : "",
    );
    setEditState(
      actions.querySelector('[data-group-move="down"]'),
      groupIndex === groups.length - 1 ? "This is already the last group." : "",
    );
    setEditState(
      actions.querySelector("[data-group-merge]"),
      groupIndex === groups.length - 1 ? "There is no group below to merge into." : "",
    );
    actions.querySelector("[data-group-record]").dataset.groupRecord = group.id;
    actions
      .querySelector('[data-group-insert="before"]')
      .dataset.groupId = group.id;
    actions
      .querySelector('[data-group-insert="after"]')
      .dataset.groupId = group.id;
    actions.querySelector("[data-group-delete]").dataset.groupDelete = group.id;
    canvas.insertBefore(actions, menu);
  }
}

/* ============================================================
 * Instruction：行层自然语言 + 技术抽屉（双层呈现，编辑真落盘）
 *
 * 唯一编辑管线：渲染直接读 processFlow.steps（与 Test/Process 共用
 * FlowGraph.flattenFlowSteps 的展平索引，杜绝索引漂移）；任何字段编辑
 * 改步骤对象后防抖 500ms 经 persistProcessFlow → flow:updateSteps 落盘
 * （主进程 parseFlow 校验 + .bak 备份）。失败时用编辑前快照回滚步骤、
 * 恢复输入框并内联报错。旧的「本地草稿伪 target 重建测试流」路径
 * （rebuildTestFlowFromItem）已删除——改「目标」不再破坏录制证据链。
 * ============================================================ */

/** 按 item.id 隔离的待落盘编辑：taskCode 在编辑时快照（防切换 Flow 后落错任务）；snapshots 供失败回滚。 */
const instructionPending = new Map();

function instructionEditable(item) {
  const state = recordingSession();
  return Boolean(
    item?.processFlow &&
      item.recordingId &&
      state.stage !== "recording" &&
      state.stage !== "preparing" &&
      !item.testRunning &&
      state.playbackInFlight !== true,
  );
}

function instructionStepEntry(item, flatIndex) {
  if (!item?.processFlow?.steps) return null;
  const flat = FlowGraph.flattenFlowSteps(item.processFlow.steps);
  const entry = flat.entries[Number(flatIndex)];
  return entry ? { entry, flat } : null;
}

/** 记录快照后原地变更步骤对象；返回该 item 的待落盘状态（未找到步骤时返回 null）。 */
function mutateInstructionStep(item, flatIndex, field, mutate) {
  const found = instructionStepEntry(item, flatIndex);
  if (!found) return null;
  const { entry } = found;
  const key = entry.flattenedStepId;
  let state = instructionPending.get(item.id);
  if (!state) {
    state = {
      timer: 0,
      taskCode: currentFlow?.code || activeFlowKey,
      snapshots: new Map(),
      fields: new Map(),
    };
    instructionPending.set(item.id, state);
  }
  if (!state.snapshots.has(key))
    state.snapshots.set(key, structuredClone(entry.step));
  mutate(entry.step);
  const edited = state.fields.get(key) || new Set();
  edited.add(field);
  state.fields.set(key, edited);
  return state;
}

function scheduleInstructionPersist(item) {
  const state = instructionPending.get(item.id);
  if (!state) return;
  clearTimeout(state.timer);
  state.timer = setTimeout(() => void flushInstructionEdits(item), 500);
}

async function flushInstructionEdits(item) {
  const state = instructionPending.get(item?.id);
  if (!state) return;
  clearTimeout(state.timer);
  instructionPending.delete(item.id);
  try {
    await persistProcessFlow(item, state.taskCode);
    updateInstructionRowTexts(item);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    item.processFlowError = message;
    // 快照原地写回步骤对象（引用不变，testFlowSteps 等派生持有同一对象）。
    const flat = FlowGraph.flattenFlowSteps(item.processFlow.steps);
    for (const [key, snapshot] of state.snapshots) {
      const entry = flat.entries.find((e) => e.flattenedStepId === key);
      if (!entry) continue;
      for (const name of Object.keys(entry.step)) delete entry.step[name];
      Object.assign(entry.step, snapshot);
    }
    syncProcessFlowPresentation(item);
    void rebuildItemTestFlow(item);
    restoreInstructionRows(item, state, message);
    showFlowlinkNotice("保存步骤修改失败：" + message, "warn");
  }
}

function flushAllInstructionEdits() {
  const state = recordingSession();
  for (const id of [...instructionPending.keys()]) {
    const item = state.items.find((entry) => entry.id === id);
    if (item) void flushInstructionEdits(item);
    else instructionPending.delete(id);
  }
}
window.addEventListener("beforeunload", flushAllInstructionEdits);

/** 落盘成功后原地刷新行文本（不整页重渲染，避免打断正在进行的输入）。 */
function updateInstructionRowTexts(item) {
  if (currentAssistantItem() !== item || item.resultTab !== "Instruction") return;
  const panel = $("summaryResultPanel");
  if (!panel) return;
  const flat = FlowGraph.flattenFlowSteps(item.processFlow?.steps || []);
  const groups = ensureProcessGroups(item);
  panel.querySelectorAll(".instruction-step").forEach((row) => {
    const entry = flat.entries[Number(row.dataset.stepIndex)];
    if (!entry) return;
    row.querySelector(".step-row-text").textContent = processStepLabel(
      entry.step,
      entry.index,
      groups,
    );
    row.classList.remove("is-dirty");
    const error = row.querySelector(".instruction-step-error");
    if (error) {
      error.hidden = true;
      error.textContent = "";
    }
  });
}

/** 落盘失败后：恢复受影响行的文本与抽屉输入框，并显示行内错误。 */
function restoreInstructionRows(item, state, message) {
  if (currentAssistantItem() !== item || item.resultTab !== "Instruction") return;
  const panel = $("summaryResultPanel");
  if (!panel) return;
  const flat = FlowGraph.flattenFlowSteps(item.processFlow.steps);
  const groups = ensureProcessGroups(item);
  for (const key of state.fields.keys()) {
    const index = flat.entries.find((e) => e.flattenedStepId === key)?.index;
    if (index === undefined) continue;
    const row = panel.querySelector(
      `.instruction-step[data-step-index="${index}"]`,
    );
    const entry = flat.entries[index];
    if (!row || !entry) continue;
    row.querySelector(".step-row-text").textContent = processStepLabel(
      entry.step,
      index,
      groups,
    );
    row.classList.remove("is-dirty");
    const fields = row.querySelector(".step-detail-fields");
    if (fields.dataset.built)
      renderInstructionDrawer(fields, item, entry, flat);
    showInstructionRowError(row, "保存失败，已还原编辑前内容：" + message);
  }
}

function showInstructionRowError(row, message) {
  const error = row?.querySelector(".instruction-step-error");
  if (!error) return;
  error.hidden = false;
  error.textContent = message;
}

/** 输入事件入口：把输入框的值写入步骤对象并安排防抖落盘。 */
function applyInstructionFieldEdit(input) {
  const row = input.closest(".instruction-step");
  const item = currentAssistantItem();
  if (!row || !instructionEditable(item)) return;
  const error = row.querySelector(".instruction-step-error");
  if (error) {
    error.hidden = true;
    error.textContent = "";
  }
  const field = input.dataset.stepField;
  const state = mutateInstructionStep(
    item,
    Number(row.dataset.stepIndex),
    field,
    (step) => {
      applyInstructionFieldValue(step, field, row, item);
    },
  );
  if (!state) return;
  row.classList.add("is-dirty");
  scheduleInstructionPersist(item);
}

function instructionInputValue(row, field) {
  const first = row.querySelector(`[data-step-field="${field}"]`);
  if (!first) return "";
  if (first.type === "checkbox") {
    if (field === "modifiers")
      return [...row.querySelectorAll('[data-step-field="modifiers"]')]
        .filter((box) => box.checked)
        .map((box) => box.value);
    return first.checked;
  }
  return first.value;
}

/** 字段 → 步骤对象的写入规则。UI 只做基本类型约束；跨字段契约由 flow:updateSteps 的 parseFlow 校验兜底。 */
function applyInstructionFieldValue(step, field, row, item) {
  const raw = instructionInputValue(row, field);
  const text = typeof raw === "string" ? raw : String(raw ?? "");
  const trimmed = text.trim();
  const intOr = (value, fallback) => {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? n : fallback;
  };
  switch (field) {
    case "label":
      if (trimmed) step.label = trimmed;
      else delete step.label;
      break;
    case "url":
      if (trimmed) step.url = trimmed;
      else if (step.kind !== "navigate") delete step.url;
      break;
    case "value":
      step.value = text;
      break;
    case "valueLines": {
      const lines = text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.length) step.value = lines.length > 1 ? lines : lines[0];
      break;
    }
    case "files": {
      const lines = text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.length) step.files = lines;
      break;
    }
    case "clear":
      step.clear = raw === true;
      break;
    case "key":
      if (trimmed) step.key = trimmed;
      break;
    case "modifiers":
      if (Array.isArray(raw) && raw.length) step.modifiers = raw;
      else delete step.modifiers;
      break;
    case "button":
      step.button = ["left", "right", "middle"].includes(text)
        ? text
        : "left";
      break;
    case "clickCount": {
      const n = intOr(text, 1);
      if (n >= 1 && n <= 3) step.clickCount = n;
      break;
    }
    case "timeout":
      if (!trimmed) delete step.timeout;
      else {
        const n = intOr(text, 0);
        if (n > 0) step.timeout = n;
      }
      break;
    case "isOptional":
      if (raw === true) step.isOptional = true;
      else delete step.isOptional;
      break;
    case "execution":
      if (text === "manual") step.execution = "manual";
      else delete step.execution;
      break;
    case "waitCondition":
      if (
        ["element", "networkIdle", "timeout", "userOperation"].includes(text)
      ) {
        step.condition = text;
        if (text !== "timeout") delete step.ms;
        if (text !== "userOperation") delete step.prompt;
      }
      break;
    case "ms":
      if (!trimmed) delete step.ms;
      else {
        const n = intOr(text, -1);
        if (n >= 0) step.ms = n;
      }
      break;
    case "prompt":
      if (trimmed) step.prompt = trimmed;
      else delete step.prompt;
      break;
    case "dialogAction":
      step.action = text === "dismiss" ? "dismiss" : "accept";
      break;
    case "dialogPromptText":
      if (trimmed) step.promptText = trimmed;
      else delete step.promptText;
      break;
    case "tabIndex":
      if (!trimmed) {
        if (step.kind === "closeTab") delete step.index;
        break;
      }
      {
        const n = intOr(text, -1);
        if (n >= 0) step.index = n;
      }
      break;
    case "into":
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) step.into = trimmed;
      break;
    case "prop":
      if (["text", "value", "attr"].includes(text)) {
        step.prop = text;
        if (text !== "attr") delete step.attr;
      }
      break;
    case "attr":
      if (trimmed && step.prop === "attr") step.attr = trimmed;
      else delete step.attr;
      break;
    case "scrollTo":
      if (text === "top" || text === "bottom") step.to = text;
      else delete step.to;
      break;
    case "deltaX":
    case "deltaY": {
      const x = String(instructionInputValue(row, "deltaX") ?? "").trim();
      const y = String(instructionInputValue(row, "deltaY") ?? "").trim();
      if (!x && !y) delete step.delta;
      else {
        const delta = {};
        if (x) delta.x = intOr(x, 0);
        if (y) delta.y = intOr(y, 0);
        step.delta = delta;
      }
      break;
    }
    case "settleNetworkIdle":
    case "settleDomQuietMs":
    case "settleMaxMs": {
      const networkIdle =
        instructionInputValue(row, "settleNetworkIdle") === true;
      const domText = String(
        instructionInputValue(row, "settleDomQuietMs") ?? "",
      ).trim();
      const maxText = String(
        instructionInputValue(row, "settleMaxMs") ?? "",
      ).trim();
      const next = {};
      if (networkIdle) next.networkIdle = true;
      if (domText) {
        const n = intOr(domText, 0);
        if (n >= 100 && n <= 5000) next.domQuietMs = n;
      }
      if (maxText) {
        const n = intOr(maxText, 0);
        if (n >= 500 && n <= 30000) next.maxMs = n;
      }
      if (Object.keys(next).length) step.settle = next;
      else delete step.settle;
      break;
    }
    case "assertionKind":
    case "assertionEquals":
    case "assertionContains":
      rebuildStepAssertion(step, row);
      break;
    case "expectKind":
    case "expectParam":
      rebuildStepExpect(step, row);
      break;
    case "trueStepId":
      if (text) step.trueStepId = text;
      else delete step.trueStepId;
      break;
    case "falseStepId":
      if (text) step.falseStepId = text;
      else delete step.falseStepId;
      break;
    case "targetRef": {
      const flat = FlowGraph.flattenFlowSteps(item.processFlow.steps);
      const source = text !== "" ? flat.steps[Number(text)] : undefined;
      if (source?.target) step.target = structuredClone(source.target);
      break;
    }
  }
}

/** 断言三元组（类型 + 期望值 + 包含文本）→ step.assertion；缺必需值时保持原值不动。 */
function rebuildStepAssertion(step, row) {
  const kind = String(instructionInputValue(row, "assertionKind") ?? "");
  if (!kind) {
    delete step.assertion;
    return;
  }
  const equals = String(
    instructionInputValue(row, "assertionEquals") ?? "",
  ).trim();
  const contains = String(
    instructionInputValue(row, "assertionContains") ?? "",
  ).trim();
  if (kind === "text") {
    const assertion = { kind: "text" };
    if (equals) assertion.equals = equals;
    if (contains) assertion.contains = contains;
    step.assertion = assertion;
  } else if (kind === "value") {
    if (equals) step.assertion = { kind: "value", equals };
  } else if (kind === "count") {
    const n = Math.round(Number(equals));
    if (Number.isInteger(n) && n >= 0)
      step.assertion = { kind: "count", equals: n };
  } else if (kind === "visible" || kind === "hidden") {
    step.assertion = { kind };
  }
}

/** 期望结果（类型 + 参数）→ step.expect；元素类期望复用步骤自身的元素证据。 */
function rebuildStepExpect(step, row) {
  const kind = String(instructionInputValue(row, "expectKind") ?? "");
  if (!kind) {
    delete step.expect;
    return;
  }
  const param = String(
    instructionInputValue(row, "expectParam") ?? "",
  ).trim();
  if (kind === "urlChange") {
    if (param) step.expect = { kind: "urlChange", pattern: param };
  } else if (kind === "domSignature") {
    if (param) step.expect = { kind: "domSignature", hash: param };
  } else if (kind === "download") {
    step.expect = param
      ? { kind: "download", filenamePattern: param }
      : { kind: "download" };
  } else if (kind === "textChange") {
    const target =
      step.expect?.kind === "textChange" ? step.expect.target : step.target;
    if (param && target)
      step.expect = {
        kind: "textChange",
        target: structuredClone(target),
        to: param,
      };
  } else if (kind === "elementVisible" || kind === "elementHidden") {
    const target =
      step.expect?.kind === kind ? step.expect.target : step.target;
    if (target)
      step.expect = { kind, target: structuredClone(target) };
  }
}

function fillInstructionPanel(panel, item) {
  const view = panel.querySelector('[data-result-tab="Instruction"]');
  if (!view) return;
  const container = view.querySelector(".grouped-steps");
  const status = view.querySelector(".instruction-status:not(.error)");
  const errorBox = view.querySelector(".instruction-status.error");
  status.hidden = true;
  errorBox.hidden = true;
  if (!item) {
    container.replaceChildren();
    return;
  }
  ensureInstructionArtifacts(item);
  if (!item.processFlow) {
    container.replaceChildren();
    if (item.processFlowError) {
      errorBox.textContent = item.processFlowError;
      errorBox.hidden = false;
    } else if (item.processFlowLoading || (item.recordingId && item.flowFile)) {
      status.textContent = "正在加载已保存的 Flow…";
      status.hidden = false;
    } else {
      renderInstructionReadonly(container, item);
      status.textContent = "该条目尚未保存为可执行 Flow，以下为只读展示。";
      status.hidden = false;
    }
    return;
  }
  const groups = ensureProcessGroups(item);
  const flat = FlowGraph.flattenFlowSteps(item.processFlow.steps);
  item.instructionExpanded ??= [];
  item.instructionStepOpen ??= [];
  const editable = instructionEditable(item);
  // 未决议 pending 与编辑互斥提示：编辑基于当前版本直接生效；pending 基于生成时
  // 的版本对比，编辑生效（version 前进）后 Confirm 会被拒绝并要求重新生成。
  if (item.pendingUpdate?.flow) {
    status.textContent =
      "存在待确认的 AI 流程更新：此处的编辑基于当前版本直接生效；编辑生效后待确认版本将无法确认（需重新生成）。请先在 AI 面板 Confirm 或 Discard。";
    status.hidden = false;
  }
  container.replaceChildren(
    ...groups.map((group) => {
      const expanded = item.instructionExpanded.includes(group.id);
      const section = rowTemplate("instructionGroupTemplate").cloneNode(true);
      section.dataset.instructionGroup = group.id;
      section.querySelector("h3").textContent = group.number + " " + group.name;
      section.querySelector(".instruction-group-tab").textContent = group.url
        ? urlBadgeText(group.url, group.tab)
        : `Tab ${group.tab}`;
      const branchEntries = group.branchEntries || [];
      const branch = section.querySelector(".instruction-group-branch");
      branch.hidden = !branchEntries.length;
      if (branchEntries.length)
        branch.textContent =
          "分支 · " +
          branchEntries
            .map(
              (entry) =>
                `当「${entry.conditionLabel}」为 ${entry.whenTrue ? "是" : "否"} 时执行`,
            )
            .join("；");
      const expand = section.querySelector(".instruction-expand");
      expand.dataset.instructionExpand = group.id;
      expand.setAttribute("aria-expanded", String(expanded));
      expand.querySelector("span").textContent = expanded
        ? "Collapse"
        : "Expand";
      flat.entries
        .slice(group.start, group.start + group.count)
        .forEach((entry, offset) => {
          const step = entry.step;
          const el = rowTemplate("instructionStepTemplate").cloneNode(true);
          el.dataset.stepIndex = entry.index;
          el.querySelector(".step-row-number").textContent =
            group.number + "-" + String(offset + 1).padStart(3, "0");
          el.querySelector(".step-row-text").textContent = processStepLabel(
            step,
            entry.index,
            groups,
          );
          // 徽标规则与 Process 图一致：原始录制 = Manual 来源；REFINED/AI 细化
          // = Automation；显式 execution: manual 或手动新增步骤始终 Manual。
          const manual =
            step.execution === "manual" ||
            String(step.id || "").startsWith("manual_") ||
            item.summary !== true;
          const icon = el.querySelector(".execution-mode-icon");
          icon.setAttribute("aria-label", manual ? "Manual" : "Automated");
          icon.title = manual ? "Manual" : "Automated";
          setIconHidden(icon.querySelector('[data-mode-icon="automated"]'), manual);
          setIconHidden(icon.querySelector('[data-mode-icon="manual"]'), !manual);
          const badges = el.querySelector(".step-badges");
          if (step.isOptional) badges.appendChild(instructionChip("可跳过"));
          if (step.execution === "manual")
            badges.appendChild(instructionChip("人工执行"));
          if (step.kind === "condition") el.classList.add("condition-step");
          const fields = el.querySelector(".step-detail-fields");
          const open = item.instructionStepOpen.includes(
            entry.flattenedStepId,
          );
          fields.hidden = !(expanded || open);
          if (!fields.hidden) renderInstructionDrawer(fields, item, entry, flat);
          el.querySelector(".instruction-step-menu").disabled = !editable;
          section.appendChild(el);
        });
      return section;
    }),
  );
}

function instructionChip(text) {
  const chip = document.createElement("span");
  chip.className = "instruction-chip";
  chip.textContent = text;
  return chip;
}

function urlBadgeText(url, tab) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return `Tab ${tab} · ${parsed.hostname}${path}`;
  } catch {
    return `Tab ${tab} · ${String(url)
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, "")}`;
  }
}

/** 未保存为 Flow 的条目（演示 / 草稿）：只读行文本，不提供编辑。 */
function renderInstructionReadonly(container, item) {
  const groups = ensureProcessGroups(item);
  container.replaceChildren(
    ...groups.map((group) => {
      const section = rowTemplate("instructionGroupTemplate").cloneNode(true);
      section.dataset.instructionGroup = group.id;
      section.querySelector("h3").textContent = group.number + " " + group.name;
      section.querySelector(".instruction-group-tab").textContent = group.url
        ? urlBadgeText(group.url, group.tab)
        : `Tab ${group.tab}`;
      section.querySelector(".instruction-expand").hidden = true;
      group.steps.forEach((text, offset) => {
        const el = rowTemplate("instructionStepTemplate").cloneNode(true);
        el.dataset.stepIndex = group.start + offset;
        el.querySelector(".step-row-number").textContent =
          group.number + "-" + String(offset + 1).padStart(3, "0");
        el.querySelector(".step-row-text").textContent = text;
        el.querySelector(".instruction-step-menu").hidden = true;
        el.querySelector(".step-detail-fields")?.remove();
        el.querySelector(".instruction-step-error")?.remove();
        section.appendChild(el);
      });
      return section;
    }),
  );
}

/** 只读 artifacts（crop 截图 URL）：主进程做路径白名单校验；结果缓存在录制项上。 */
function ensureInstructionArtifacts(item) {
  if (!item || item.instructionArtifacts || item.instructionArtifactsLoading)
    return;
  if (!item.recordingId || !window.flowlink?.recording?.artifactsPath) return;
  item.instructionArtifactsLoading = true;
  window.flowlink.recording
    .artifactsPath({
      taskCode: currentFlow?.code || activeFlowKey,
      recordingId: item.recordingId,
    })
    .then((result) => {
      item.instructionArtifacts = result;
    })
    .catch((error) => {
      item.instructionArtifacts = { artifactsDir: "", crops: [] };
      console.error("[instruction] 加载目标截图失败:", error);
    })
    .finally(() => {
      item.instructionArtifactsLoading = false;
      if (currentAssistantItem() === item && item.resultTab === "Instruction")
        renderSummaryWorkspace();
    });
}

/** 步骤 value 的掩码：密码字段的明文输入以圆点展示，secret 变量模板串原样展示。 */
function maskedInputValue(item, step) {
  const raw = String(step.value ?? "");
  const match = raw.match(/^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/);
  if (
    match &&
    (item.processFlow?.variables || []).some(
      (variable) => variable.name === match[1] && variable.secret,
    )
  )
    return { value: raw, masked: false };
  const isPassword =
    step.target?.observed?.attributes?.type?.toLowerCase() === "password";
  if (isPassword && !match) return { value: "••••••••", masked: true };
  return { value: raw, masked: false };
}

function candidateValueText(candidate) {
  const value = candidate?.value;
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object")
    return value.name || value.text || value.role || JSON.stringify(value);
  return String(value);
}

/** 技术抽屉：按 kind 输出结构化字段（字段矩阵见 docs/archive/plan-instruction-revamp.md §3.2）。 */
function renderInstructionDrawer(fieldsEl, item, entry, flat) {
  const step = entry.step;
  fieldsEl.dataset.built = "true";
  fieldsEl.replaceChildren();
  const editable = instructionEditable(item);
  const esc = (value) => escapeHTML(String(value ?? ""));
  const dis = editable ? "" : " disabled";
  const groups = item.processFlow.steps.filter(
    (candidate) => candidate?.kind === "group",
  );
  const text = (field, label, value, extra = "") =>
    `<label>${label}<input type="text" data-step-field="${field}" value="${esc(value)}"${dis}${extra}></label>`;
  const number = (field, label, value, extra = "") =>
    `<label>${label}<input type="number" data-step-field="${field}" value="${value === undefined || value === null ? "" : esc(value)}"${dis}${extra}></label>`;
  const select = (field, label, options, current) =>
    `<label>${label}<select data-step-field="${field}"${dis}>${options
      .map(
        (option) =>
          `<option value="${esc(option.value)}"${String(option.value) === String(current ?? "") ? " selected" : ""}>${esc(option.label)}</option>`,
      )
      .join("")}</select></label>`;
  const check = (field, label, checked, extra = "") =>
    `<label class="instruction-check">${label}<input type="checkbox" data-step-field="${field}"${checked ? " checked" : ""}${dis}${extra}></label>`;
  const area = (field, label, value, extra = "") =>
    `<label>${label}<textarea data-step-field="${field}" rows="3"${dis}${extra}>${esc(value)}</textarea></label>`;

  fieldsEl.insertAdjacentHTML(
    "beforeend",
    `<p class="instruction-kind-line">操作类型 · ${esc(
      STEP_KIND_TEXT[step.kind] || step.kind,
    )}${step.id ? ` <span class="instruction-step-id">#${esc(step.id)}</span>` : ""}</p>`,
  );

  const grid = [];
  switch (step.kind) {
    case "navigate":
      grid.push(
        text("url", "URL", step.url ?? "", ` required placeholder="https://…"`),
      );
      break;
    case "openTab":
      grid.push(text("url", "URL（可选）", step.url ?? ""));
      break;
    case "click":
      grid.push(
        select(
          "button",
          "鼠标按键",
          [
            { value: "left", label: "left" },
            { value: "right", label: "right" },
            { value: "middle", label: "middle" },
          ],
          step.button || "left",
        ),
      );
      grid.push(
        number("clickCount", "点击次数", step.clickCount ?? 1, ` min="1" max="3" step="1"`),
      );
      if (step.position)
        grid.push(
          `<label>点击坐标（closed shadow · 只读）<input value="${esc(
            `${step.position.x} , ${step.position.y}`,
          )}" disabled></label>`,
        );
      break;
    case "input": {
      const display = maskedInputValue(item, step);
      grid.push(
        text(
          "value",
          display.masked ? "填写内容（密码字段 · 输入新值替换）" : "填写内容",
          display.value,
          display.masked ? ` autocomplete="new-password"` : "",
        ),
      );
      grid.push(check("clear", "填前清空", step.clear !== false));
      break;
    }
    case "select":
      grid.push(
        area(
          "valueLines",
          "选项值（多选时每行一个）",
          Array.isArray(step.value) ? step.value.join("\n") : (step.value ?? ""),
        ),
      );
      break;
    case "key":
      grid.push(text("key", "按键", step.key ?? "", ` required`));
      grid.push(
        `<div class="instruction-modifiers"><span>组合键</span>${["Alt", "Control", "Meta", "Shift"]
          .map(
            (mod) =>
              `<label class="instruction-check"><input type="checkbox" data-step-field="modifiers" value="${mod}"${(step.modifiers || []).includes(mod) ? " checked" : ""}${dis}>${mod}</label>`,
          )
          .join("")}</div>`,
      );
      break;
    case "wait":
      grid.push(
        select(
          "waitCondition",
          "等待条件",
          [
            { value: "element", label: "元素出现" },
            { value: "networkIdle", label: "网络空闲" },
            { value: "timeout", label: "固定时长" },
            { value: "userOperation", label: "用户操作" },
          ],
          step.condition,
        ),
      );
      if (step.condition === "timeout")
        grid.push(number("ms", "时长（毫秒）", step.ms ?? 1000, ` min="0" step="1"`));
      if (step.condition === "userOperation")
        grid.push(text("prompt", "提示语", step.prompt ?? ""));
      break;
    case "assert":
    case "condition": {
      const assertion = step.assertion;
      const assertionKind = assertion?.kind ?? "";
      grid.push(
        select(
          "assertionKind",
          step.kind === "assert" ? "断言" : "条件判断",
          [
            { value: "", label: "（无）" },
            { value: "visible", label: "可见" },
            { value: "hidden", label: "隐藏" },
            { value: "text", label: "文本" },
            { value: "value", label: "值" },
            { value: "count", label: "数量" },
          ],
          assertionKind,
        ),
      );
      const showEquals =
        !assertionKind || ["text", "value", "count"].includes(assertionKind);
      const showContains = !assertionKind || assertionKind === "text";
      grid.push(
        `<label${showEquals ? "" : " hidden"}>${
          assertionKind === "count" ? "期望数量" : "期望值"
        }<input type="text" data-step-field="assertionEquals" value="${esc(
          assertion && "equals" in assertion ? String(assertion.equals) : "",
        )}"${dis}></label>`,
      );
      grid.push(
        `<label${showContains ? "" : " hidden"}>包含文本<input type="text" data-step-field="assertionContains" value="${esc(
          assertion?.contains ?? "",
        )}"${dis}></label>`,
      );
      if (step.kind === "condition") {
        // 分支目标 = 同 Flow 内任意已存在步骤（缺省 = 顺序继续）。
        const stepOptions = [{ value: "", label: "（缺省：顺序继续）" }];
        const collectSteps = (list) => {
          for (const candidate of list || []) {
            if (candidate?.kind === "group") collectSteps(candidate.steps);
            else if (candidate?.id && candidate.id !== step.id)
              stepOptions.push({
                value: candidate.id,
                label:
                  (candidate.label?.trim() || candidate.id) +
                  "（" +
                  candidate.kind +
                  "）",
              });
          }
        };
        collectSteps(groups.flatMap((group) => group.steps || []));
        grid.push(
          select("trueStepId", "为真跳转到", stepOptions, step.trueStepId),
        );
        grid.push(
          select("falseStepId", "为假跳转到", stepOptions, step.falseStepId),
        );
      }
      break;
    }
    case "extract":
      grid.push(text("into", "存入变量", step.into ?? "", ` placeholder="变量名"`));
      grid.push(
        select(
          "prop",
          "提取属性",
          [
            { value: "text", label: "text" },
            { value: "value", label: "value" },
            { value: "attr", label: "attr" },
          ],
          step.prop || "text",
        ),
      );
      if ((step.prop || "text") === "attr")
        grid.push(text("attr", "属性名", step.attr ?? ""));
      break;
    case "upload":
      grid.push(area("files", "文件（模板串，每行一个）", (step.files || []).join("\n")));
      break;
    case "dialog":
      grid.push(
        select(
          "dialogAction",
          "弹窗操作",
          [
            { value: "accept", label: "accept（确认）" },
            { value: "dismiss", label: "dismiss（取消）" },
          ],
          step.action,
        ),
      );
      grid.push(text("dialogPromptText", "prompt 输入（可选）", step.promptText ?? ""));
      break;
    case "switchTab":
      grid.push(
        number("tabIndex", "目标标签页序号（0 起）", step.index ?? 0, ` min="0" step="1"`),
      );
      break;
    case "closeTab":
      grid.push(
        number(
          "tabIndex",
          "标签页序号（0 起，留空 = 当前）",
          step.index ?? "",
          ` min="0" step="1"`,
        ),
      );
      break;
    case "scroll":
      grid.push(
        select(
          "scrollTo",
          "滚动到",
          [
            { value: "", label: "按偏移" },
            { value: "top", label: "顶部" },
            { value: "bottom", label: "底部" },
          ],
          step.to ?? "",
        ),
      );
      grid.push(number("deltaX", "横向偏移（px）", step.delta?.x ?? "", ` step="1"`));
      grid.push(number("deltaY", "纵向偏移（px）", step.delta?.y ?? "", ` step="1"`));
      break;
    default:
      break;
  }
  if (!["wait", "assert", "condition"].includes(step.kind))
    grid.push(
      select(
        "execution",
        "执行方式",
        [
          { value: "automated", label: "自动执行" },
          { value: "manual", label: "人工执行（回放时暂停确认）" },
        ],
        step.execution === "manual" ? "manual" : "automated",
      ),
    );
  grid.push(
    number("timeout", "校验等待上限（毫秒，可选）", step.timeout ?? "", ` min="1" step="1" placeholder="5000"`),
  );
  grid.push(check("isOptional", "可跳过（目标未出现时跳过不报错）", !!step.isOptional));

  // 目标查看器：元素证据只读展示（crop 截图 + 候选 + 指纹），不支持自由文本改定位。
  const ELEMENT_KINDS = new Set([
    "click",
    "input",
    "select",
    "hover",
    "upload",
    "extract",
    "assert",
    "condition",
    "drag",
  ]);
  if (
    ELEMENT_KINDS.has(step.kind) ||
    (["key", "scroll", "wait"].includes(step.kind) && step.target)
  )
    appendTargetViewer(fieldsEl, item, entry);

  const gridEl = document.createElement("div");
  gridEl.className = "step-field-grid";
  gridEl.innerHTML = grid.join("");
  fieldsEl.appendChild(gridEl);

  const settle = step.settle || {};
  fieldsEl.insertAdjacentHTML(
    "beforeend",
    `<fieldset class="instruction-fieldset"><legend>执行前沉降（可选）</legend><div class="step-field-grid">
      ${check("settleNetworkIdle", "等待网络空闲", !!settle.networkIdle)}
      ${number("settleDomQuietMs", "DOM 静默毫秒（100–5000）", settle.domQuietMs ?? "", ` min="100" max="5000" step="1"`)}
      ${number("settleMaxMs", "总上限毫秒（500–30000）", settle.maxMs ?? "", ` min="500" max="30000" step="1"`)}
    </div></fieldset>`,
  );
  const expect = step.expect;
  const expectParamValue = !expect
    ? ""
    : expect.kind === "urlChange"
      ? expect.pattern
      : expect.kind === "domSignature"
        ? expect.hash
        : expect.kind === "download"
          ? expect.filenamePattern
          : expect.kind === "textChange"
            ? expect.to
            : "";
  const expectParamLabel = !expect
    ? "参数"
    : expect.kind === "urlChange"
      ? "URL 模式"
      : expect.kind === "domSignature"
        ? "DOM 签名哈希"
        : expect.kind === "download"
          ? "文件名模式（可选）"
          : "变为文本";
  const showExpectParam =
    expect &&
    ["urlChange", "domSignature", "download", "textChange"].includes(expect.kind);
  fieldsEl.insertAdjacentHTML(
    "beforeend",
    `<fieldset class="instruction-fieldset"><legend>期望结果（可选）</legend><div class="step-field-grid">
      ${select(
        "expectKind",
        "类型",
        [
          { value: "", label: "（无）" },
          { value: "urlChange", label: "URL 变化" },
          { value: "elementVisible", label: "元素可见" },
          { value: "elementHidden", label: "元素隐藏" },
          { value: "textChange", label: "文本变化" },
          { value: "domSignature", label: "DOM 签名" },
          { value: "download", label: "触发下载" },
        ],
        expect?.kind ?? "",
      )}
      <label${showExpectParam ? "" : " hidden"}>${esc(expectParamLabel)}<input type="text" data-step-field="expectParam" value="${esc(
        expectParamValue,
      )}"${dis}></label>
    </div></fieldset>`,
  );
  const hint = document.createElement("p");
  hint.className = "instruction-drawer-hint";
  hint.textContent = editable
    ? "编辑自动保存到 Flow 文件（校验失败会还原并提示）。"
    : "录制或回放进行中：字段为只读。";
  fieldsEl.appendChild(hint);
}

/** 目标查看器：证据展示 + 元素库引用 + 重录该组；不可自由文本改定位。 */
function appendTargetViewer(fieldsEl, item, entry) {
  const step = entry.step;
  const ref = step.kind === "drag" ? step.from : step.target;
  const box = document.createElement("div");
  box.className = "target-viewer";
  const title = document.createElement("p");
  title.className = "target-viewer-title";
  title.textContent =
    step.kind === "drag" ? "起点目标 · 元素证据（只读）" : "目标 · 元素证据（只读）";
  box.appendChild(title);
  if (!ref) {
    const empty = document.createElement("p");
    empty.className = "target-viewer-empty";
    empty.textContent = "该步骤没有元素目标。";
    box.appendChild(empty);
  } else {
    const crop = (item.instructionArtifacts?.crops || []).find(
      (candidate) => candidate.stepId === step.id,
    );
    if (crop?.rect && crop?.frame && crop.rect.width > 0 && crop.rect.height > 0) {
      // screencast 采集的整帧 + sidecar 裁剪矩形：CSS 定位裁出元素区域显示
      const scale = Math.min(320 / crop.rect.width, 240 / crop.rect.height, 3);
      const frame = document.createElement("div");
      frame.className = "target-crop-frame";
      frame.style.width = `${Math.round(crop.rect.width * scale)}px`;
      frame.style.height = `${Math.round(crop.rect.height * scale)}px`;
      const img = document.createElement("img");
      img.src = crop.url;
      img.alt = "目标元素截图";
      img.loading = "lazy";
      img.style.width = `${Math.round(crop.frame.width * scale)}px`;
      img.style.height = `${Math.round(crop.frame.height * scale)}px`;
      img.style.left = `${-Math.round(crop.rect.x * scale)}px`;
      img.style.top = `${-Math.round(crop.rect.y * scale)}px`;
      frame.appendChild(img);
      box.appendChild(frame);
    } else if (crop) {
      const img = document.createElement("img");
      img.className = "target-crop";
      img.src = crop.url;
      img.alt = "目标元素截图";
      img.loading = "lazy";
      box.appendChild(img);
    } else {
      const none = document.createElement("p");
      none.className = "target-viewer-empty";
      none.textContent = item.instructionArtifactsLoading
        ? "目标截图加载中…"
        : "无目标截图（旧录制或 crop 缺失）。";
      box.appendChild(none);
    }
    const facts = document.createElement("dl");
    facts.className = "target-facts";
    const addFact = (term, detail) => {
      if (!detail) return;
      const dt = document.createElement("dt");
      dt.textContent = term;
      const dd = document.createElement("dd");
      dd.textContent = detail;
      facts.append(dt, dd);
    };
    addFact("描述", ref.description);
    const fingerprint = ref.fingerprint;
    if (fingerprint)
      addFact(
        "指纹",
        [fingerprint.tag, fingerprint.role, fingerprint.accessibleName]
          .filter(Boolean)
          .join(" · ") +
          (fingerprint.stableHash
            ? ` · #${String(fingerprint.stableHash).slice(0, 8)}`
            : ""),
      );
    if (ref.observed?.shadowRootType === "closed")
      addFact("Shadow", "closed（按坐标回放）");
    addFact("邻近文本", (ref.nearbyText || []).join(" / "));
    if (facts.children.length) box.appendChild(facts);
    const list = document.createElement("ul");
    list.className = "target-candidates";
    for (const candidate of ref.candidates || []) {
      const li = document.createElement("li");
      li.textContent = `${candidate.kind} · ${candidateValueText(candidate)}${
        candidate.score != null ? ` · score ${candidate.score}` : ""
      }${candidate.source ? ` · ${candidate.source}` : ""}`;
      list.appendChild(li);
    }
    if (list.children.length) box.appendChild(list);
  }
  const actions = document.createElement("div");
  actions.className = "target-viewer-actions";
  if (instructionEditable(item) && step.kind !== "drag") {
    const refs = FlowGraph.flattenFlowSteps(item.processFlow.steps)
      .steps.map((other, index) => ({ other, index }))
      .filter(({ other }) => other?.target && other !== step);
    if (refs.length) {
      const selectEl = document.createElement("select");
      selectEl.dataset.stepField = "targetRef";
      selectEl.setAttribute("aria-label", "从元素库引用目标");
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "从元素库引用目标…";
      selectEl.appendChild(placeholder);
      for (const { other, index } of refs) {
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = `${other.kind} · ${
          other.target.description ||
          candidateValueText(other.target.candidates?.[0]) ||
          other.id
        }`;
        selectEl.appendChild(option);
      }
      actions.appendChild(selectEl);
    }
    if (item.recordingId && entry.groupId) {
      const rerecord = document.createElement("button");
      rerecord.type = "button";
      rerecord.className = "target-rerecord";
      rerecord.dataset.instructionRerecord = entry.groupId;
      rerecord.textContent = "重录这一步（替换所在组）";
      actions.appendChild(rerecord);
    }
  }
  box.appendChild(actions);
  fieldsEl.appendChild(box);
}

/** 行内编辑一句话描述：Enter/失焦保存（写 step.label 并立即落盘），Esc 取消。 */
function beginInlineLabelEdit(row, item, entry) {
  if (!instructionEditable(item)) return;
  if (row.querySelector(".instruction-label-editor")) return;
  const textEl = row.querySelector(".step-row-text");
  const editor = document.createElement("textarea");
  editor.className = "instruction-label-editor";
  editor.rows = 1;
  editor.value = entry.step.label ?? "";
  editor.placeholder = "用一句话描述这一步；留空恢复自动生成的描述";
  editor.setAttribute("aria-label", "步骤描述");
  textEl.hidden = true;
  textEl.after(editor);
  const autoSize = () => {
    editor.style.height = "auto";
    editor.style.height = Math.max(28, editor.scrollHeight) + "px";
  };
  autoSize();
  editor.oninput = autoSize;
  let done = false;
  const close = (apply) => {
    if (done) return;
    done = true;
    const value = editor.value;
    editor.remove();
    textEl.hidden = false;
    if (!apply) return;
    const state = mutateInstructionStep(
      item,
      row.dataset.stepIndex,
      "label",
      (step) => {
        if (value.trim()) step.label = value.trim();
        else delete step.label;
      },
    );
    if (state) void flushInstructionEdits(item);
  };
  editor.onblur = () => close(true);
  editor.onkeydown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close(false);
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      close(true);
    }
  };
  editor.focus();
}

let instructionMenuEl = null;
function onInstructionMenuKey(e) {
  if (e.key === "Escape") closeInstructionStepMenu();
}
function onInstructionMenuPointerDown(e) {
  if (instructionMenuEl && !instructionMenuEl.contains(e.target))
    closeInstructionStepMenu();
}
function closeInstructionStepMenu() {
  instructionMenuEl?.remove();
  instructionMenuEl = null;
  document.removeEventListener("keydown", onInstructionMenuKey);
  document.removeEventListener("pointerdown", onInstructionMenuPointerDown);
}

function openInstructionStepMenu(button) {
  const item = currentAssistantItem();
  const row = button.closest(".instruction-step");
  const found = item && row ? instructionStepEntry(item, row.dataset.stepIndex) : null;
  if (!found || !instructionEditable(item)) return;
  const { entry } = found;
  closeInstructionStepMenu();
  const group = item.processFlow.steps.find(
    (candidate) => candidate.kind === "group" && candidate.id === entry.groupId,
  );
  if (!group) return;
  const index = group.steps.indexOf(entry.step);
  const isCondition = entry.step.kind === "condition";
  const items = [
    { key: "edit", label: "编辑描述", disabled: false },
    {
      key: "toggle",
      label: item.instructionStepOpen.includes(entry.flattenedStepId)
        ? "收起技术字段"
        : "展开技术字段",
      disabled: false,
    },
    { key: "up", label: "上移", disabled: isCondition || index <= 0 },
    {
      key: "down",
      label: "下移",
      disabled:
        isCondition ||
        index >= group.steps.length - 1 ||
        group.steps[index + 1]?.kind === "condition",
    },
    {
      key: "insert",
      label: "在此后插入步骤",
      disabled: isCondition && index === group.steps.length - 1,
    },
    { key: "delete", label: "删除步骤", disabled: false },
    {
      key: "rerecord",
      label: "重录这一步（替换所在组）",
      disabled: !item.recordingId,
    },
  ];
  const menu = document.createElement("div");
  menu.className = "instruction-menu";
  menu.setAttribute("role", "menu");
  for (const entryItem of items) {
    const buttonItem = document.createElement("button");
    buttonItem.type = "button";
    buttonItem.setAttribute("role", "menuitem");
    buttonItem.dataset.menuKey = entryItem.key;
    buttonItem.disabled = entryItem.disabled;
    buttonItem.textContent = entryItem.label;
    menu.appendChild(buttonItem);
  }
  const rect = button.getBoundingClientRect();
  document.body.appendChild(menu);
  menu.style.left =
    Math.min(window.innerWidth - menu.offsetWidth - 8, Math.max(8, rect.left)) +
    "px";
  menu.style.top = Math.min(window.innerHeight - menu.offsetHeight - 8, rect.bottom + 4) + "px";
  instructionMenuEl = menu;
  document.addEventListener("keydown", onInstructionMenuKey);
  document.addEventListener("pointerdown", onInstructionMenuPointerDown);
  menu.onclick = (e) => {
    const target = e.target.closest("button[data-menu-key]");
    if (!target || target.disabled) return;
    closeInstructionStepMenu();
    switch (target.dataset.menuKey) {
      case "edit":
        beginInlineLabelEdit(row, item, entry);
        break;
      case "toggle":
        toggleInstructionDrawer(item, row, entry);
        break;
      case "up":
        void moveInstructionStep(item, entry.index, -1);
        break;
      case "down":
        void moveInstructionStep(item, entry.index, 1);
        break;
      case "insert":
        showManualStepEditor(item, entry.groupId, index + 1);
        break;
      case "delete":
        void deleteInstructionStep(item, entry.index);
        break;
      case "rerecord":
        void beginGroupRecording(item, entry.groupId, "replace");
        break;
    }
  };
}

function toggleInstructionDrawer(item, row, entry) {
  const fields = row.querySelector(".step-detail-fields");
  if (!fields) return;
  const id = entry.flattenedStepId;
  const wasOpen = !fields.hidden;
  fields.hidden = wasOpen;
  if (!wasOpen && !fields.dataset.built) {
    const found = instructionStepEntry(item, row.dataset.stepIndex);
    if (found) renderInstructionDrawer(fields, item, found.entry, found.flat);
  }
  item.instructionStepOpen = wasOpen
    ? item.instructionStepOpen.filter((value) => value !== id)
    : [...item.instructionStepOpen, id];
}

/** 组内上移/下移：condition 始终保持组尾（schema 契约）。失败还原并提示。 */
async function moveInstructionStep(item, flatIndex, delta) {
  const found = instructionStepEntry(item, flatIndex);
  if (!found) return;
  await flushInstructionEdits(item); // 先落盘防抖中的编辑，避免结构变更与回滚快照交叉
  const { entry } = found;
  const group = item.processFlow.steps.find(
    (candidate) => candidate.kind === "group" && candidate.id === entry.groupId,
  );
  if (!group) return;
  const index = group.steps.indexOf(entry.step);
  const target = index + delta;
  if (
    target < 0 ||
    target >= group.steps.length ||
    entry.step.kind === "condition" ||
    group.steps[target]?.kind === "condition"
  )
    return;
  const snapshot = structuredClone(item.processFlow.steps);
  const [moved] = group.steps.splice(index, 1);
  group.steps.splice(target, 0, moved);
  try {
    await persistProcessFlow(item);
    renderSummaryWorkspace();
  } catch (error) {
    item.processFlow = { ...item.processFlow, steps: snapshot };
    syncProcessFlowPresentation(item);
    void rebuildItemTestFlow(item);
    item.processFlowError =
      error instanceof Error ? error.message : String(error);
    showFlowlinkNotice(
      "移动步骤失败：" + item.processFlowError,
      "warn",
    );
    renderSummaryWorkspace();
  }
}

/** 快操作：直接删除步骤（不加确认）。删空所在组时连同空组删除，并清理
 * 指向被删步骤的 condition true/false 引用改为缺省（顺序继续，与
 * deleteProcessGroup 同款清理）；
 * 唯一组的最后一步不允许删（契约要求 Flow 至少保留一个组），保存失败用
 * 快照回滚并提示。 */
// 收集组内全部步骤 id（含嵌套组，用于删除时清理步骤级分支目标）。
function stepIdsOf(group) {
  const ids = new Set();
  const walk = (list) => {
    for (const step of list || []) {
      if (step?.kind === "group") walk(step.steps);
      else if (step?.id) ids.add(step.id);
    }
  };
  walk(group?.steps);
  return ids;
}

// 步骤级分支目标清理：指向被删步骤 id 的 trueStepId/falseStepId 改为缺省
//（顺序继续），避免悬空引用（契约校验会拒绝保存悬空目标）。
function clearDanglingBranchRefs(steps, removedIds) {
  if (!removedIds?.size) return;
  const clear = (list) => {
    for (const step of list || []) {
      if (step?.kind === "group") clear(step.steps);
      else if (step?.kind === "condition") {
        if (step.trueStepId && removedIds.has(step.trueStepId)) delete step.trueStepId;
        if (step.falseStepId && removedIds.has(step.falseStepId)) delete step.falseStepId;
      }
    }
  };
  clear(steps);
}

async function deleteInstructionStep(item, flatIndex) {
  // flush 成功会以服务端返回的 steps 替换引用，之后的查找都必须在 flush 之后做。
  await flushInstructionEdits(item);
  const found = instructionStepEntry(item, flatIndex);
  if (!found) return;
  const { entry } = found;
  const steps = item.processFlow.steps;
  const group = steps.find(
    (candidate) => candidate.kind === "group" && candidate.id === entry.groupId,
  );
  if (!group) return;
  const groups = steps.filter((candidate) => candidate.kind === "group");
  if (groups.length <= 1 && group.steps.length <= 1) {
    showFlowlinkNotice("流程至少需要保留一个步骤，无法删除。", "warn");
    return;
  }
  const groupView = ensureProcessGroups(item).find((g) => g.id === entry.groupId);
  const numberLabel = groupView
    ? groupView.number + "-" + String(entry.index - groupView.start + 1).padStart(3, "0")
    : "步骤";
  const snapshot = structuredClone(steps);
  const removedIds = new Set(entry.step.id ? [entry.step.id] : []);
  const groupStepIds = stepIdsOf(group);
  group.steps.splice(group.steps.indexOf(entry.step), 1);
  let removedGroup = false;
  if (!group.steps.length) {
    steps.splice(steps.indexOf(group), 1);
    removedGroup = true;
    for (const id of groupStepIds) removedIds.add(id);
  }
  clearDanglingBranchRefs(steps, removedIds);
  item.instructionStepOpen = item.instructionStepOpen.filter(
    (value) => value !== entry.flattenedStepId,
  );
  try {
    await persistProcessFlow(item);
    showFlowlinkNotice(
      removedGroup
        ? "已删除步骤 " + numberLabel + "，所在空组已一并删除。"
        : "已删除步骤 " + numberLabel + "。",
    );
    renderSummaryWorkspace();
  } catch (error) {
    item.processFlow = { ...item.processFlow, steps: snapshot };
    syncProcessFlowPresentation(item);
    void rebuildItemTestFlow(item);
    item.processFlowError =
      error instanceof Error ? error.message : String(error);
    showFlowlinkNotice(
      "删除步骤失败：" + item.processFlowError,
      "warn",
    );
    renderSummaryWorkspace();
  }
}

function fillReferencePanel(panel, item) {
  const section = panel.querySelector('[data-result-tab="Reference"]');
  const files = ensureReferenceFiles(item);
  const selectedCount = files.filter((file) => file.selected).length;
  section.querySelector("#referenceSelectAll").disabled = !files.length;
  section.querySelector("#referenceRows").replaceChildren(
    ...files.map((file) => {
      const row = rowTemplate("referenceRowTemplate").cloneNode(true);
      row.dataset.referenceRow = file.id;
      const check = row.querySelector(".recording-check");
      check.dataset.referenceCheck = file.id;
      check.setAttribute("aria-label", "Select " + file.name);
      check.checked = !!file.selected;
      const isVariable = file.kind === "variable";
      const span = row.querySelector("span.reference-name");
      const link = row.querySelector("a.reference-name");
      span.hidden = !isVariable;
      link.hidden = isVariable;
      if (isVariable) {
        span.textContent = file.name;
      } else {
        link.href = file.url;
        link.setAttribute("download", file.name);
        link.textContent = file.name;
      }
      row.querySelector('[data-slot="type"]').textContent = file.type;
      row.querySelector('[data-slot="value"]').textContent = isVariable
        ? file.secret && file.value
          ? "••••••"
          : file.value || ""
        : "";
      const [edit, remove] = row.querySelectorAll(
        ".reference-row-actions .icon-button",
      );
      edit.dataset.referenceEdit = file.id;
      edit.setAttribute("aria-label", "Update " + file.name);
      remove.dataset.referenceDelete = file.id;
      remove.setAttribute("aria-label", "Delete " + file.name);
      return row;
    }),
  );
  section.querySelector("#referenceStatus").textContent =
    item?.referenceLoadError || "";
  section.querySelector("#referenceDownload").disabled = !selectedCount;
  section.querySelector("#referenceAdd").disabled = !!(
    item?.referenceVariablesLoading || item?.referenceLoadError
  );
}

function fillMetricPanel(panel) {
  const state = metricPreference();
  panel.querySelector("[data-metric-groups]").replaceChildren(
    ...metricChoices.map(([name, options]) => {
      const group = rowTemplate("metricGroupTemplate").cloneNode(true);
      group.setAttribute("aria-label", name);
      group.querySelector("h3").textContent = name;
      group.querySelector(".metric-consent-options").replaceChildren(
        ...options.map(([id, label]) => {
          const row = rowTemplate("metricRowTemplate").cloneNode(true);
          const input = row.querySelector("input");
          input.dataset.metricChoice = id;
          input.checked = state.selected.includes(id);
          row.querySelector("span").textContent = label;
          return row;
        }),
      );
      return group;
    }),
  );
  panel.querySelector("#metricConsentStatus").textContent = state.message;
}

function fillRecordPanel(panel, item) {
  const section = panel.querySelector('[data-result-tab="Record"]');
  const media = item?.media || {},
    screenshots = media.screenshots || [];
  const name = item?.name || "Recording";
  const playerRoot = section.querySelector(".rrweb-player-root");
  const video = section.querySelector("video");
  const preview = section.querySelector(
    ".recording-frame-preview:not(.recording-frame-empty)",
  );
  if (media.rrwebDir) {
    // rrweb 录制：DOM 事件回放优先，旧 video/poster 管线隐藏。
    video.hidden = true;
    video.removeAttribute("src");
    preview.hidden = true;
    section.querySelector(".recording-frame-empty").hidden = true;
    section.querySelector(".recording-media-name").textContent =
      name + " - rrweb replay";
    renderRecordingScreenshots(section, screenshots);
    mountRrwebPlayer(playerRoot, media.rrwebDir);
    return;
  }
  teardownRrwebPlayer(playerRoot);
  const poster = media.posterFile
    ? "file:///" + String(media.posterFile).replace(/\\/g, "/")
    : screenshots[0]?.image || "";
  video.hidden = !media.videoURL;
  if (media.videoURL) {
    video.setAttribute("aria-label", name + " video");
    video.src = media.videoURL;
  } else {
    video.removeAttribute("src");
  }
  const showPreview = !media.videoURL && !!poster;
  preview.hidden = !showPreview;
  if (showPreview) {
    const img = preview.querySelector("img");
    img.src = poster;
    img.alt = name + " poster";
  }
  section.querySelector(".recording-frame-empty").hidden =
    !!media.videoURL || !!poster;
  section.querySelector(".recording-media-name").textContent =
    name + (media.videoURL ? ".webm" : " - frame recording");
  renderRecordingScreenshots(section, screenshots);
}

function renderRecordingScreenshots(section, screenshots) {
  const wall = section.querySelector(".recording-screenshots");
  // 步骤截图墙：无截图（旧录制 / 步骤截图采集被禁用）时显示空态说明，不渲染占位块。
  wall.hidden = false;
  if (!screenshots.length) {
    const empty = document.createElement("p");
    empty.className = "recording-screenshots-empty";
    empty.textContent =
      "这段录制没有步骤截图（历史录制，或步骤截图采集已用 FLOWLINK_DISABLE_RECORDER_SHOTS 禁用）。";
    wall.replaceChildren(empty);
    return;
  }
  wall.replaceChildren(
    ...screenshots.map((file) => {
      const shot = rowTemplate("recordingScreenshotTemplate").cloneNode(true);
      shot.dataset.screenshotZoom = file.image;
      shot.setAttribute("aria-label", "Zoom " + file.name);
      const img = shot.querySelector("img");
      img.src = file.image;
      img.alt = file.name;
      shot.querySelector("span").textContent = file.name;
      return shot;
    }),
  );
}

/* ================================================================
 * rrweb 回放器（Record 标签页）：每个标签页一个 Replayer 实例，
 * 由统一主时钟按 activation 时间线驱动显示与播放。
 * ================================================================ */
let rrwebPlayerSession = null;
let rrwebPlayerMountId = 0;
/** mountRrwebPlayer 的加载快照：诊断报告在播放器未挂载/挂载失败时也要能给出事实。 */
let rrwebDiag = null;

function teardownRrwebPlayer(root) {
  if (rrwebPlayerSession) {
    const session = rrwebPlayerSession;
    rrwebPlayerSession = null;
    session.destroy();
  }
  rrwebDiag = null;
  if (!root) return;
  root.hidden = true;
  root.querySelector(".rrweb-player-stage")?.replaceChildren();
  root.querySelector(".rrweb-tabs")?.replaceChildren();
  const errorBox = root.querySelector(".rrweb-error");
  if (errorBox) {
    errorBox.hidden = true;
    errorBox.textContent = "";
  }
  const diagnostic = root.querySelector(".rrweb-diagnostic");
  if (diagnostic) diagnostic.hidden = true;
}

function rrwebPlayerNotice(text) {
  const node = document.createElement("div");
  node.className = "rrweb-notice";
  node.textContent = text;
  return node;
}

function rrwebTimeLabel(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function copyTextFallback(text, done) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    if (document.execCommand("copy")) done?.();
    else showFlowlinkNotice("复制失败，请手动选择报告文本复制。", "warn");
  } catch {
    showFlowlinkNotice("复制失败，请手动选择报告文本复制。", "warn");
  }
  textarea.remove();
}

/** 统计 document.styleSheets 中 .replayer-* 规则命中情况（跨域表记 access denied）。 */
function rrwebVendorCssDiagnostics() {
  const result = { sheets: 0, denied: 0, rules: 0, matchedSheets: [] };
  const countRules = (rules, sheetLabel) => {
    let found = 0;
    for (const rule of rules) {
      const selector = rule.selectorText || "";
      if (selector.includes(".replayer-")) found++;
      const nested = rule.cssRules;
      if (nested) found += countRules(nested, sheetLabel);
    }
    if (found) result.matchedSheets.push(`${sheetLabel} (${found})`);
    return found;
  };
  for (const sheet of Array.from(document.styleSheets || [])) {
    result.sheets++;
    const label = sheet.href || "(inline)";
    try {
      result.rules += countRules(Array.from(sheet.cssRules || []), label);
    } catch {
      result.denied++;
      result.matchedSheets.push(`${label} (access denied)`);
    }
  }
  return result;
}

/** 采集当前回放环境事实，生成纯文本诊断报告；任何子项失败都不抛异常。 */
function collectRrwebDiagnostics(root) {
  const lines = [];
  const push = (line) => lines.push(line);
  push("FlowLink rrweb replay diagnostics");
  push("generated: " + new Date().toISOString());
  push("");
  push("[load]");
  const diag = rrwebDiag;
  if (!diag) {
    push("phase: not-mounted (no rrweb session for the current item)");
  } else {
    push("phase: " + diag.phase);
    push("dir: " + (diag.dir || "(unknown)"));
    if (diag.error) push("error: " + diag.error);
    push(
      "tabs loaded: " +
        (diag.tabs?.length || 0) +
        " (usable: " +
        (diag.usableTabs || 0) +
        ")",
    );
    push("total events: " + (diag.totalEvents || 0));
    push("activations: " + (diag.activations || 0));
    for (const [index, tab] of (diag.tabs || []).entries())
      push(
        "  tab #" +
          (index + 1) +
          ' "' +
          (tab.label || "") +
          '": events=' +
          tab.events +
          " metaSnapshots=" +
          tab.metaSnapshots,
      );
    push(
      "stylesMissed (fallback inline styles injected): " +
        (diag.stylesMissed ? "yes" : "no"),
    );
  }
  push("");
  push("[vendor css]");
  try {
    const css = rrwebVendorCssDiagnostics();
    push(
      "styleSheets scanned: " +
        css.sheets +
        " (access denied: " +
        css.denied +
        ")",
    );
    push(".replayer-* rules found: " + css.rules);
    for (const entry of css.matchedSheets) push("  " + entry);
  } catch (err) {
    push("vendor css check failed: " + (err?.message || err));
  }
  push("");
  push("[live session]");
  const describeEl = (el) => {
    if (!el) return "(missing)";
    try {
      const cs = getComputedStyle(el);
      return (
        "position=" +
        cs.position +
        " display=" +
        cs.display +
        " client=" +
        el.clientWidth +
        "x" +
        el.clientHeight
      );
    } catch (err) {
      return "(computed style failed: " + (err?.message || err) + ")";
    }
  };
  const describeRect = (el) => {
    if (!el) return "(missing)";
    try {
      const r = el.getBoundingClientRect();
      return (
        "rect=" +
        Math.round(r.x) +
        "," +
        Math.round(r.y) +
        " " +
        Math.round(r.width) +
        "x" +
        Math.round(r.height)
      );
    } catch (err) {
      return "(rect failed: " + (err?.message || err) + ")";
    }
  };
  const session = rrwebPlayerSession;
  if (!session || !session.players?.size) {
    push("session: not mounted");
  } else {
    for (const entry of session.players.values()) {
      push('tab "' + entry.label + '":');
      try {
        const meta = entry.replayer.getMetaData();
        push(
          "  meta: startTime=" +
            meta.startTime +
            " totalTime=" +
            meta.totalTime,
        );
      } catch (err) {
        push("  meta: (getMetaData failed: " + (err?.message || err) + ")");
      }
      const wrapper = entry.replayer.wrapper;
      push("  wrapper: " + describeEl(wrapper));
      const iframe = wrapper?.querySelector("iframe");
      push("  iframe: " + describeRect(iframe) + " " + describeEl(iframe));
      try {
        const doc = iframe?.contentDocument;
        push(
          "  iframe-doc: " +
            (doc
              ? "readyState=" +
                doc.readyState +
                " bodyChildren=" +
                (doc.body ? doc.body.childElementCount : "no-body") +
                " sheets=" +
                doc.styleSheets.length +
                " htmlBg=" +
                (doc.documentElement
                  ? getComputedStyle(doc.documentElement).backgroundColor
                  : "?")
              : "NULL"),
        );
      } catch (err) {
        push("  iframe-doc: (access failed: " + (err?.message || err) + ")");
      }
      push("  mouse: " + describeEl(wrapper?.querySelector(".replayer-mouse")));
      push(
        "  mouse-tail: " +
          describeEl(wrapper?.querySelector(".replayer-mouse-tail")),
      );
      push(
        "  tab-view: hidden=" +
          entry.container.hidden +
          " client=" +
          entry.container.clientWidth +
          "x" +
          entry.container.clientHeight,
      );
    }
  }
  push("");
  push("[layout]");
  try {
    const stage = root?.querySelector(".rrweb-player-stage");
    if (stage) {
      const cs = getComputedStyle(stage);
      push(
        "stage: client=" +
          stage.clientWidth +
          "x" +
          stage.clientHeight +
          " styleHeight=" +
          (stage.style.height || "(none)") +
          " display=" +
          cs.display +
          " position=" +
          cs.position +
          " overflow=" +
          cs.overflow,
      );
    } else push("stage: (missing)");
    const views = root
      ? Array.from(root.querySelectorAll(".rrweb-tab-view"))
      : [];
    push("tab-views: " + views.length);
    for (const [index, view] of views.entries())
      push(
        "  view #" +
          (index + 1) +
          ": hidden=" +
          view.hidden +
          " client=" +
          view.clientWidth +
          "x" +
          view.clientHeight,
      );
    if (root) {
      push(
        "player-root: hidden=" +
          root.hidden +
          " client=" +
          root.clientWidth +
          "x" +
          root.clientHeight,
      );
      const errorBox = root.querySelector(".rrweb-error");
      push(
        "error-box: hidden=" +
          (errorBox?.hidden ?? "(missing)") +
          " text=" +
          JSON.stringify(errorBox?.textContent || ""),
      );
    }
  } catch (err) {
    push("layout check failed: " + (err?.message || err));
  }
  return lines.join("\n");
}

function showRrwebDiagnostics(root) {
  if (!root) return;
  const box = root.querySelector(".rrweb-diagnostic");
  const report = box?.querySelector(".rrweb-diagnostic-report");
  if (!box || !report) return;
  let text;
  try {
    text = collectRrwebDiagnostics(root);
  } catch (err) {
    text = "diagnostics failed: " + (err?.message || err);
  }
  report.textContent = text;
  box.hidden = false;
  report.focus?.();
}

async function mountRrwebPlayer(root, rrwebDir) {
  if (!root) return;
  teardownRrwebPlayer(root);
  root.hidden = false;
  const mountId = ++rrwebPlayerMountId;
  const stage = root.querySelector(".rrweb-player-stage");
  const tabsRow = root.querySelector(".rrweb-tabs");
  const toggleBtn = root.querySelector(".rrweb-toggle");
  const seek = root.querySelector(".rrweb-seek");
  const timeLabel = root.querySelector(".rrweb-time");
  const followBtn = root.querySelector(".rrweb-follow");
  const errorBox = root.querySelector(".rrweb-error");
  const showError = (message) => {
    if (rrwebDiag) {
      rrwebDiag.phase = "error";
      rrwebDiag.error = message;
    }
    stage.replaceChildren();
    tabsRow.replaceChildren();
    errorBox.hidden = false;
    errorBox.textContent = message;
    timeLabel.textContent = "0:00 / 0:00";
    seek.max = 0;
    seek.value = 0;
  };
  // 诊断入口在任何阶段（含加载失败）都必须可用，故在最早的 early return 之前绑定。
  const diagnosticBox = root.querySelector(".rrweb-diagnostic");
  const diagnoseBtn = root.querySelector(".rrweb-diagnose");
  if (diagnoseBtn) diagnoseBtn.onclick = () => showRrwebDiagnostics(root);
  const copyBtn = root.querySelector(".rrweb-diagnostic-copy");
  if (copyBtn)
    copyBtn.onclick = () => {
      const report = diagnosticBox?.querySelector(".rrweb-diagnostic-report");
      const text = report?.textContent || "";
      if (!text) return;
      const done = () => showFlowlinkNotice("诊断报告已复制。");
      if (navigator.clipboard?.writeText)
        navigator.clipboard.writeText(text).then(done, () =>
          copyTextFallback(text, done),
        );
      else copyTextFallback(text, done);
    };
  const closeDiagBtn = root.querySelector(".rrweb-diagnostic-close");
  if (closeDiagBtn && diagnosticBox) closeDiagBtn.onclick = () => (diagnosticBox.hidden = true);
  if (diagnosticBox) diagnosticBox.hidden = true;
  rrwebDiag = {
    dir: rrwebDir,
    phase: "loading",
    startedAt: new Date().toISOString(),
    tabs: [],
    totalEvents: 0,
    usableTabs: 0,
    activations: 0,
    stylesMissed: false,
    error: "",
  };
  stage.replaceChildren(rrwebPlayerNotice("正在加载录制数据…"));
  errorBox.hidden = true;

  let data;
  try {
    data = await window.flowlink.recording.loadRrweb(rrwebDir);
  } catch (err) {
    showError(`录制数据加载失败：${err?.message || err}`);
    return;
  }
  if (mountId !== rrwebPlayerMountId) return; // 用户已切换到其他录制
  const Replayer = window.__flowlinkRrweb?.Replayer;
  if (typeof Replayer !== "function") {
    showError(
      "rrweb 播放器不可用（dist/renderer-vendor.js 缺失或未包含 Replayer），请重新构建。",
    );
    return;
  }
  const usableTabs = (data.tabs || []).filter(
    (tab) =>
      Array.isArray(tab.events) &&
      tab.events.length >= 2 &&
      // 无全量快照事件的流永远画不出画面（黑屏静默），按不可回放过滤。
      tab.events.some((event) => event && event.type === 2),
  );
  if (!usableTabs.length) {
    showError("这段录制没有可回放的 rrweb 事件。");
    return;
  }
  rrwebDiag.phase = "mounted";
  rrwebDiag.tabs = usableTabs.map((tab) => ({
    tabId: tab.tabId,
    label: tab.label || "",
    events: tab.events.length,
    metaSnapshots: tab.events.filter((event) => event && event.type === 2)
      .length,
  }));
  rrwebDiag.totalEvents = usableTabs.reduce(
    (sum, tab) => sum + tab.events.length,
    0,
  );
  rrwebDiag.usableTabs = usableTabs.length;
  rrwebDiag.activations = (data.activations || []).length;

  const session = {
    players: new Map(),
    activationOffsets: [],
    base: 0,
    duration: 0,
    time: 0,
    playing: false,
    manualTab: null,
    current: null,
    raf: 0,
    lastTick: 0,
    destroy() {
      cancelAnimationFrame(this.raf);
      for (const entry of this.players.values()) {
        try {
          entry.replayer.pause(0);
        } catch {}
        try {
          entry.replayer.destroy?.();
        } catch {}
        entry.isPlaying = false;
      }
      this.players.clear();
    },
  };
  rrwebPlayerSession = session;

  // 逐标签页建 Replayer；全部建完后统一量取首个快照尺寸再缩放、再隐藏非活动页。
  let reference = null;
  for (const tab of usableTabs) {
    const container = document.createElement("div");
    container.className = "rrweb-tab-view";
    stage.appendChild(container);
    let replayer;
    try {
      replayer = new Replayer(tab.events, {
        root: container,
        mouseTail: true,
        showWarning: false,
      });
    } catch (err) {
      container.remove();
      console.error("[rrweb] Replayer 创建失败：", err);
      continue;
    }
    const meta = replayer.getMetaData();
    const entry = {
      tabId: tab.tabId,
      label: tab.label || `Tab ${session.players.size + 1}`,
      container,
      replayer,
      // 该标签页时间轴在全局时间轴上的偏移与时长（毫秒）
      offset: 0,
      duration: Math.max(0, meta.totalTime),
      isPlaying: false,
      btn: null,
    };
    session.players.set(entry.tabId, entry);
    try {
      replayer.pause(0);
    } catch {}
    if (!reference) reference = entry;
  }
  if (!session.players.size) {
    showError("rrweb 事件无法解析为可回放的时间轴。");
    return;
  }

  // vendor.css 命中检测：rrweb 基础样式未生效时 mouse/mouse-tail 按文档流排版，
  // 会把回放 iframe 挤出舞台（黑屏）。未命中 → 向各播放器根节点注入兜底内联
  // 样式（wrapper/iframe/mouse-tail 定位三件套）并控制台告警；样式与渲染
  // 双失败时由下方量测超时兜底转为显式错误，绝不静默黑屏。
  const computedPosition = (el) => {
    try {
      return el ? getComputedStyle(el).position : "";
    } catch {
      return "";
    }
  };
  let stylesMissed = false;
  for (const entry of session.players.values()) {
    const wrapper = entry.replayer.wrapper;
    if (!wrapper) continue;
    const tail = wrapper.querySelector(".replayer-mouse-tail");
    const mouse = wrapper.querySelector(".replayer-mouse");
    if (computedPosition(tail || mouse) === "absolute") continue;
    stylesMissed = true;
    wrapper.style.position = "relative";
    const iframe = wrapper.querySelector("iframe");
    if (iframe) {
      iframe.style.display = "block";
      iframe.style.position = "relative";
    }
    if (mouse) mouse.style.position = "absolute";
    if (tail) {
      tail.style.position = "absolute";
      tail.style.pointerEvents = "none";
    }
  }
  if (rrwebDiag) rrwebDiag.stylesMissed = stylesMissed;
  if (stylesMissed) {
    console.warn(
      "[rrweb] 基础样式未生效（dist/renderer-vendor.css 缺失或加载失败），已注入兜底内联样式。",
    );
  }

  session.base = Math.min(
    ...[...session.players.values()].map((entry) => {
      const meta = entry.replayer.getMetaData();
      return meta.startTime;
    }),
  );
  for (const entry of session.players.values()) {
    entry.offset = entry.replayer.getMetaData().startTime - session.base;
  }
  session.duration = Math.max(
    ...[...session.players.values()].map(
      (entry) => entry.offset + entry.duration,
    ),
    0,
  );
  session.activationOffsets = (data.activations || [])
    .filter((a) => typeof a?.ts === "number" && session.players.has(a.tabId))
    .map((a) => ({ offset: a.ts - session.base, tabId: a.tabId }))
    .sort((a, b) => a.offset - b.offset);

  // 缩放：按第一个标签页的录制视口比例适配舞台宽度。
  // 量测必须等 iframe 真实渲染：rrweb 的 iframe 文档是异步创建的，构造完成
  // 瞬间 rect 常为 0×0（真机实测 t=0 为 0×0、约 1.2s 后才正常），按 0 量测
  // 会把舞台高度算错、内容出不了可视区（回放黑屏）。rAF/timeout 双驱动轮询
  // 上限 3s，期间显示加载态；超时用兜底尺寸继续，不阻塞回放。
  const measureNotice = rrwebPlayerNotice("正在准备回放画面…");
  stage.appendChild(measureNotice);
  const referenceRect = () => {
    try {
      return reference.replayer.iframe?.getBoundingClientRect() || null;
    } catch {
      return null;
    }
  };
  let docWidth = 0;
  let docHeight = 0;
  await new Promise((resolve) => {
    const deadline = performance.now() + 3000;
    const poll = () => {
      if (mountId !== rrwebPlayerMountId) return resolve();
      const rect = referenceRect();
      if (rect && rect.width > 0 && rect.height > 0) {
        docWidth = rect.width;
        docHeight = rect.height;
        return resolve();
      }
      if (performance.now() >= deadline) return resolve();
      // rAF 优先（可见时最平滑），120ms timeout 兜底（窗口隐藏时 rAF 停发）。
      let settled = false;
      const tick = () => {
        if (settled) return;
        settled = true;
        poll();
      };
      requestAnimationFrame(tick);
      setTimeout(tick, 120);
    };
    poll();
  });
  measureNotice.remove();
  if (mountId !== rrwebPlayerMountId) return;
  if (!docWidth && stylesMissed) {
    showError(
      "回放器无法渲染画面：基础样式（dist/renderer-vendor.css）未加载，且播放器尺寸量测超时。请运行 npm run build 重新构建后重启应用。",
    );
    return;
  }
  try {
    docWidth = docWidth || 1280;
    docHeight = docHeight || 720;
    const stageWidth = Math.max(240, stage.clientWidth || 800);
    const scale = Math.min(2, stageWidth / docWidth);
    for (const entry of session.players.values()) {
      entry.replayer.wrapper.style.transformOrigin = "top left";
      entry.replayer.wrapper.style.transform = `scale(${scale})`;
    }
    stage.style.height = `${Math.min(560, Math.round(docHeight * scale))}px`;
  } catch {}

  // 标签按钮
  for (const entry of session.players.values()) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rrweb-tab-btn";
    btn.textContent = entry.label;
    btn.title = entry.label;
    btn.addEventListener("click", () => {
      session.manualTab = entry.tabId;
      followBtn.hidden = false;
      applyView();
    });
    entry.btn = btn;
    tabsRow.appendChild(btn);
  }
  followBtn.addEventListener("click", () => {
    session.manualTab = null;
    followBtn.hidden = true;
    applyView();
  });

  const activeTabAt = (time) => {
    let winner = null;
    for (const a of session.activationOffsets) {
      if (time >= a.offset) winner = session.players.get(a.tabId);
      else break;
    }
    return winner || reference;
  };

  const updateTimeUi = () => {
    seek.max = String(Math.max(0, Math.round(session.duration)));
    seek.value = String(Math.min(session.duration, Math.round(session.time)));
    timeLabel.textContent = `${rrwebTimeLabel(session.time)} / ${rrwebTimeLabel(session.duration)}`;
  };

  const setToggleLabel = () => {
    toggleBtn.textContent = session.playing ? "Pause" : "Play";
  };

  function applyView() {
    const desired = session.manualTab
      ? session.players.get(session.manualTab) || reference
      : activeTabAt(session.time);
    session.current = desired;
    for (const entry of session.players.values()) {
      const show = entry === desired;
      entry.container.hidden = !show;
      entry.btn?.classList.toggle("is-active", show);
      if (!show && entry.isPlaying) {
        try {
          entry.replayer.pause();
        } catch {}
        entry.isPlaying = false;
      }
    }
    const local = Math.min(
      desired.duration,
      Math.max(0, session.time - desired.offset),
    );
    if (session.playing && local < desired.duration) {
      try {
        desired.replayer.play(local);
        desired.isPlaying = true;
      } catch {}
    } else {
      try {
        desired.replayer.pause(local);
      } catch {}
      desired.isPlaying = false;
    }
    updateTimeUi();
  }

  const startPlayback = () => {
    if (session.time >= session.duration) session.time = 0;
    session.playing = true;
    session.lastTick = performance.now();
    setToggleLabel();
    applyView();
  };
  const pausePlayback = () => {
    session.playing = false;
    setToggleLabel();
    applyView();
  };

  toggleBtn.addEventListener("click", () => {
    if (session.playing) pausePlayback();
    else startPlayback();
  });
  seek.addEventListener("input", () => {
    session.time = Math.min(session.duration, Math.max(0, Number(seek.value) || 0));
    applyView();
  });

  const tick = (now) => {
    session.raf = requestAnimationFrame(tick);
    const dt = session.lastTick ? now - session.lastTick : 0;
    session.lastTick = now;
    if (!session.playing) return;
    session.time = Math.min(session.duration, session.time + dt);
    if (!session.manualTab && activeTabAt(session.time) !== session.current) {
      applyView();
    } else {
      updateTimeUi();
    }
    if (session.time >= session.duration) {
      session.playing = false;
      setToggleLabel();
      applyView();
    }
  };
  session.raf = requestAnimationFrame(tick);

  // 只清加载提示，绝不移动 tab-view 容器：iframe 一旦脱离文档其 document 即销毁，
  // 重新插入产生新空文档，rrweb 2.2 的沙箱注册（WeakSet）随之失效，之后所有
  // FullSnapshot 重建静默抛 REBUILD_TARGET_ERROR —— 回放永久黑屏的根因。
  stage.querySelectorAll(".rrweb-notice").forEach((node) => node.remove());
  applyView();
}

let activeFlowKey = "TASKFLOW-001",
  drawerView = "Profile",
  recordingSequence = 1102,
  browserPageSequence = 0;

function generatedRecordingName() {
  const now = new Date(),
    mm = String(now.getMonth() + 1).padStart(2, "0"),
    dd = String(now.getDate()).padStart(2, "0"),
    hh = String(now.getHours()).padStart(2, "0"),
    min = String(now.getMinutes()).padStart(2, "0");
  return `RECORD-${mm}${dd}-${hh}${min}`;
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
  // 按需为每个 Flow 创建完整的工作区状态。下面会话级的页面导航字段只是兼容镜像，
  // 实际 URL 和历史记录以当前活动浏览器标签页为准。
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
      aiConversations: new Map(),
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
  // 标签页切换后同步旧版会话级调用方；每个页面自己的 URL 和历史记录仍以页面对象为准。
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
  // 打开工作区即视为重新打开浏览器（空闲时）：回到该流程起始 URL 的单一新页，
  // 清除上一个 taskflow / 上一轮运行遗留的标签页与状态。
  if (typeof window.resetBrowserToTaskflowStart === "function")
    void window.resetBrowserToTaskflowStart(activeFlowKey);
  showDrawerTab("Profile");
}

function showDrawerTab(view) {
  // 录制过程中不允许离开 Design；同时切换控件和工作区，确保两者的无障碍状态一致。
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
  // 布局副本沿用模板中的 ID。先重命名非活动副本的 ID，再恢复当前副本的原始 ID，
  // 以维持 $() 的查找规则。
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
  // 每次挂载浏览器界面时重新绑定导航事件；每个标签页的 frame 只创建一次，
  // 在重新排列视图时继续复用。
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
  // 通过已渲染标签页的签名避免无谓替换 DOM，防止焦点丢失；
  // 同时根据所选页面同步 frame 显示状态及地址栏、历史导航控件。
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
    tabs.replaceChildren(
      ...state.browserTabs.map((tab, index) => {
        const label = browserPageLabel(tab);
        const row = rowTemplate("browserTabTemplate").cloneNode(true);
        const tabButton = row.querySelector("[data-browser-tab]");
        tabButton.dataset.browserTab = tab.id;
        tabButton.setAttribute(
          "aria-label",
          "Browser page " + (index + 1) + ": " + label,
        );
        tabButton.setAttribute(
          "aria-selected",
          String(tab.id === page.id),
        );
        tabButton.tabIndex = tab.id === page.id ? 0 : -1;
        tabButton.textContent = label;
        const close = row.querySelector("[data-browser-close]");
        close.dataset.browserClose = tab.id;
        close.setAttribute(
          "aria-label",
          "Close browser page " + (index + 1),
        );
        return row;
      }),
    );
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
  const menu = $("recordingImportMenu");
  if (menu)
    menu.onclick = (e) => {
      const option = e.target.closest("[data-import-action]");
      if (option) runImportAction(option.dataset.importAction);
    };
}

function closeImportMenu() {
  const menu = $("recordingImportMenu");
  if (menu) {
    menu.hidden = true;
    $("prepareRecording")?.setAttribute("aria-expanded", "false");
  }
}

function runImportAction(action) {
  closeImportMenu();
  const state = recordingSession();
  if (action === "browser") {
    void prepareRecording();
    return;
  }
  if (action === "goal") {
    state.aiOpen = true;
    renderRecordingWorkspace();
    const input = $("assistantInput");
    if (input) {
      input.placeholder = "Describe the goal to capture…";
      input.focus();
    }
  }
}

function renderRecordingWorkspace() {
  // 分析和实时浏览是同一布局的两种排列方式。移动或隐藏现有浏览器/结果节点，
  // 而不是重建浏览器，以保留各标签页的 iframe 和捕获状态。
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
  $("recordingItems").replaceChildren(
    ...state.items.map((item) => {
      const row = rowTemplate("recordingItemRowTemplate").cloneNode(true);
      row.classList.toggle("current", state.focused === item.id);
      const check = row.querySelector(".recording-check");
      check.dataset.recordingCheck = item.id;
      check.setAttribute("aria-label", "Select " + item.name);
      check.checked = !!item.checked;
      const name = row.querySelector(".recording-row-name");
      name.dataset.recordingOpen = item.id;
      name.textContent = item.name;
      const remove = row.querySelector(".recording-delete");
      remove.dataset.recordingDelete = item.id;
      remove.setAttribute("aria-label", "Delete " + item.name);
      remove.disabled = state.stage === "recording";
      return row;
    }),
  );
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
  button.textContent = recording ? "Stop" : "Import";
  button.setAttribute("aria-label", recording ? "Stop recording" : "Import");
  button.setAttribute("aria-expanded", String(!recording && ! $("recordingImportMenu")?.hidden));
  button.disabled = !!state.pending?.finishing || !!state.groupPreparing;
  button.onclick = recording
    ? finishBrowserRecording
    : () => {
        const menu = $("recordingImportMenu");
        if (!menu) return;
        menu.hidden = !menu.hidden;
        button.setAttribute("aria-expanded", String(!menu.hidden));
      };
}

function refineSelection(state) {
  // Refine 需要至少一个已分析的录制，且不能混入未分析的录制（与点击处理同一判定）。
  const chosen = state.items.filter((item) => item.checked && item.analyzed);
  const hasUnanalyzed = state.items.some((item) => item.checked && !item.analyzed);
  return { chosen, ready: chosen.length > 0 && !hasUnanalyzed, hasUnanalyzed };
}

function updateSummaryState() {
  const state = recordingSession(),
    button = $("summarizeRecordings");
  if (!button) return;
  const busy = state.stage === "recording" || state.stage === "preparing";
  button.disabled = busy || !refineSelection(state).ready;
}

async function prepareRecording() {
  // 若地址栏草稿与当前页面不同，新录制应先导航到草稿地址；
  // 导航成功后才能重置录制状态，避免失败时丢失当前会话。
  const state = recordingSession();
  if (state.stage === "recording") return;
  // 新一轮录制前先整理原生浏览器会话；既有录制项不在这一步删除。
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
  // 只有地址校验和必要导航均成功后，才切换到录制状态并清空旧 pending。
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
  // 首次导航属于全新的捕获内容；重新录制则保留目标节点元数据，
  // 不再创建第二个 pending 项。
  const state = recordingSession();
  if (state.stage === "recording") return;
  const page = activeBrowserPage();
  // 首次进入时尽力把草稿地址导航到位；重新录制则保留目标项和其元数据。
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
  // 先发布录制阶段并重绘控件，再启动媒体和记录初始导航，保证界面立即反馈。
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
  // 媒体异步收尾期间拦截重复的 Stop。收尾完成后再将 pending 对象一次性提交到会话列表，
  // 避免列表出现不完整或重复的录制项。
  const state = recordingSession();
  if (state.stage !== "recording" || !state.pending || state.pending.finishing)
    return;
  const pending = state.pending;
  pending.finishing = true;
  updateBrowserChrome();
  // 在媒体异步停止期间保留 pending 引用；完成前不把半成品加入 items。
  pending.media = await stopRecordingMedia(state);
  if (state.pending !== pending) return;
  if (pending.reRecordTarget) {
    // 节点重录由专用提交逻辑替换原节点，不走新增录制项的通用路径。
    finishNodeRecording(state);
    updateBrowserChrome();
    return;
  }
  const item = pending,
    number = ++recordingSequence;
  item.id = "recording-" + Date.now().toString(36) + "-" + number;
  item.name = "Recording " + number;
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
  // 先更新 URL 和历史记录，再加载 frame，使浏览器工具栏立即显示目标地址；
  // URL 无效时不改动页面状态。
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
  // 本地演示路由使用 srcdoc，外部页面则在 sandbox frame 中导航。
  // snapshot bridge 只注入本地内容，不注入远程源。
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
  // 合并后的 Flow 为每段源录制分配互不重叠的页面索引区间；
  // 同时递归调整嵌套分组，确保标签页引用仍然一致。
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
  // 优先使用每段录制对应的已持久化 Flow；仅对原型演示录制回退到界面推导的数据。
  // 页面索引偏移用于避免不同录制的标签页编号冲突。
  const mergedSteps = [];
  const mergedVariables = new Map();
  let pageOffset = 0;
  for (const item of chosen) {
    let steps = [];
    if (item.flowFile) {
      try {
        const flow = await window.flowlink.flow.load(item.flowFile);
        steps = flow?.steps || [];
        for (const variable of flow?.variables || []) {
          if (!mergedVariables.has(variable.name))
            mergedVariables.set(variable.name, variable);
        }
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
    variables: [...mergedVariables.values()],
    steps: mergedSteps,
  };
}

function summarizeRecordings() {
  const state = recordingSession();
  // 与 updateSummaryState 相同的守卫：守卫失败时给出可见提示而不是静默返回。
  if (state.stage === "recording" || state.stage === "preparing") return;
  const { chosen, ready, hasUnanalyzed } = refineSelection(state);
  if (!ready) {
    state.aiOpen = true;
    renderRecordingWorkspace();
    appendAIMessage(
      currentAssistantContext(),
      "assistant",
      hasUnanalyzed
        ? "Refine needs analyzed recordings only. The current selection includes recordings that have not finished analysis; uncheck them and try again."
        : "Select at least one analyzed recording to refine.",
    );
    return;
  }
  // Refine 打开欢迎选项菜单（merge/generate/optimize）；选 optimize 才进入
  // 预设勾选+自由文本表单。进入分析页本身不再自动弹出任何欢迎选项。
  // 勾选快照是 refine 表单路径的唯一来源（提交时显式使用，不做聊天粘性）。
  state.refineMenuOpen = true;
  state.aiRefineSources = chosen;
  state.aiOpen = true;
  renderRecordingWorkspace();
  renderAIPanel();
  $("assistantInput")?.focus();
}

async function confirmRecordingSummary() {
  // 将选中的已分析录制合并为一个界面项，并在展示前保存合并后的 Flow。
  // 即使保存失败，该项仍可供界面查看，但 Test 标签页没有可回放的已保存录制。
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
    name: "Refined " + recordingSequence,
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
    const recording = await window.flowlink.recording.persistMerged({
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
  // 结果标签页共用一个工作区，并在 Test 与其他标签页之间移动浏览器。
  // Test 浏览器按录制项标记重置，避免每次渲染都重复执行异步初始化。
  const state = recordingSession(),
    item = currentAssistantItem();
  // 焦点可能指向不存在的录制（跨会话的迟到回调曾把它写坏）：回到浏览器视图，
  // 而不是在下面的 item.resultTab 上抛 TypeError、把渲染打断成半截布局。
  if (!item) {
    state.view = "browser";
    renderRecordingWorkspace();
    return;
  }
  const active = item.resultTab || "Process";
  // 切走标签页/录制项前，冲掉 Instruction 未保存的防抖编辑（best effort）。
  flushAllInstructionEdits();
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
  results.hidden = active === "Test";
  if (active === "Test") {
    testShell.prepend(tabs);
    const browserSlot = testShell.querySelector(".test-tab-browser-slot");
    if (state.browserElement) browserSlot.appendChild(state.browserElement);
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
  fillResultPanel(resultPanel, active, item);
  if (active === "Test" && state.browserElement) {
    state.browserElement.hidden = false;
    mountBrowserSurface();
  }
  $("profileTab").disabled = false;
  $("previous").disabled = false;
  syncFloatingAIDock(active === "Test" ? testShell : results);
  bindRecordingList();
  bindWorkspaceResize();
  renderAIPanel();
  bindStepEditor();
  bindProcessMap();
  if (
    (active === "Process" || active === "Test" || active === "Instruction") &&
    item?.recordingId &&
    !item.processFlowLoaded &&
    !item.processFlowLoading &&
    !item.processFlowError
  ) {
    // Test 标签页也加载已保存 Flow：进度列表分组化需要组名/编号
    // （与 Process 图共用 ensureProcessGroups 视图）；Instruction 的编辑
    // 管线同样挂在 processFlow 上（编辑真落盘的前置条件）。
    void hydrateProcessFlow(item).then((loaded) => {
      if (
        loaded &&
        currentAssistantItem() === item &&
        (item.resultTab === "Process" ||
          item.resultTab === "Test" ||
          item.resultTab === "Instruction")
      )
        renderSummaryWorkspace();
    });
  }
  bindReferenceFiles();
  bindMetricPreferences();
  bindScreenshotZoom();
  const tabButtons = tabs.querySelectorAll("[data-summary-tab]");
  // 进入 Test 后自动执行：等浏览器重置完成，且仅在没有进行中的回放时发起一次。
  const autoRunTest = (target) => {
    if (!target.recordingId || typeof window.runFlowlinkTest !== "function")
      return;
    void (async () => {
      if (state.testResetPromise) await state.testResetPromise;
      // 浏览器重置期间用户可能已关闭本 taskflow、切换到另一个 taskflow：
      // 此时绝不能在旧录制上发起回放（runFlowlinkTest 会用新 taskflow 的 code
      // + 旧录制 id 调 IPC，主进程报「找不到该录制」且视图被拽回旧 Test 态）。
      if (recordingSession() !== state || !state.items.includes(target)) return;
      if (
        target.resultTab !== "Test" ||
        target.testRunning ||
        state.playbackInFlight
      )
        return;
      window.runFlowlinkTest(target);
    })();
  };
  tabButtons.forEach((button) => {
    button.onclick = () => {
      const nextTab = button.dataset.summaryTab;
      if (item.resultTab === "Test" || nextTab === "Test")
        resetTestExecutionStatus(item);
      if (nextTab === "Test") state.aiOpen = true;
      item.resultTab = nextTab;
      renderSummaryWorkspace();
      $(summaryTabId(item.resultTab)).focus();
      if (nextTab === "Test") autoRunTest(item);
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
      if (nextTab === "Test") state.aiOpen = true;
      item.resultTab = nextTab;
      renderSummaryWorkspace();
      $(summaryTabId(item.resultTab)).focus();
      if (nextTab === "Test") autoRunTest(item);
    };
  });
}

async function deleteRecording(id) {
  // 捕获过程中禁止删除。若删除的是当前选中项，先选定相邻项并推导后续视图/阶段，
  // 再重新渲染。
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
  const itemToDelete = state.items[index];
  if (itemToDelete.recordingId && window.flowlink?.tasks?.removeRecording) {
    try {
      await window.flowlink.tasks.removeRecording(
        currentFlow?.code || activeFlowKey,
        itemToDelete.recordingId,
      );
    } catch (err) {
      console.error("Could not delete recording files:", err);
      alert("Could not delete recording: " + err.message);
      return;
    }
  }
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
  // 只接受来自本应用标签页 frame 的消息，再将快照和演示交互交给当前会话的录制流程。
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

// 画布右键菜单（步骤/组）为 position:fixed：点击菜单外任意处关闭。
// canvas.onclick 只覆盖画布内，画布外（AI 面板等）的点击在此统一关闭。
document.addEventListener("pointerdown", (e) => {
  if (e.target.closest("#canvasStepMenu,#canvasGroupMenu")) return;
  const stepMenu = document.getElementById("canvasStepMenu");
  if (stepMenu && !stepMenu.hidden) {
    stepMenu.hidden = true;
    stepMenu.dataset.stepIndex = "";
  }
  const groupMenu = document.getElementById("canvasGroupMenu");
  if (groupMenu && !groupMenu.hidden) {
    groupMenu.hidden = true;
    groupMenu.dataset.groupId = "";
  }
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

// 本地对话和节点捕获原型，不会发起外部 AI 请求。
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
    // dock 是全局单例，但 deactivate 的布局会被 ensureRecordingLayout 整体
    // id 后缀化——dock 若恰好留在那个布局里就会带着 aiToggle--<flow> 的 id
    // 被搬进新工作区，$("aiToggle") 从此失效。移入时恢复原始 id（仅当没有
    // 其他元素占用，避免与浏览器工具栏按 id 互换的 aiToggle 撞车）并清掉
    // 换名标记。
    if (existing.dataset.workspaceId) {
      if (!document.getElementById(existing.dataset.workspaceId))
        existing.id = existing.dataset.workspaceId;
      delete existing.dataset.workspaceId;
    } else if (existing.id !== "aiToggle" && !document.getElementById("aiToggle")) {
      existing.id = "aiToggle";
    }
    if (existing.parentElement !== target) target.appendChild(existing);
    bindAIDock();
    return;
  }
  target.insertAdjacentHTML("beforeend", aiDockMarkup());
  bindAIDock();
}

function ensureAssistantData(item) {
  const state = recordingSession();
  state.aiConversations ??= new Map();
  // Replay（Test）标签页使用独立对话：录制项的聊天按标签页拆分，
  // Replay 中的消息（如回放诊断）不与其他标签页的对话互通。
  const replay = item !== state.guideAssistant && item?.resultTab === "Test";
  const key =
    (item === state.guideAssistant
      ? "guide"
      : String(item.recordingId || item.id || "current")) +
    (replay ? "-replay" : "");
  let conversation = state.aiConversations.get(key);
  if (!conversation) {
    // 仅首个对话继承 item 上已有的聊天；其余标签页从空白开始，避免共享同一数组。
    const inherit = !replay && !item.chatScopeClaimed;
    item.chatScopeClaimed = true;
    conversation = {
      messages: inherit && Array.isArray(item.chat) ? item.chat : [],
      draft:
        inherit && typeof item.chatDraft === "string" ? item.chatDraft : "",
    };
    state.aiConversations.set(key, conversation);
  }
  item.steps ??= [];
  item.chat = conversation.messages;
  item.chatDraft = conversation.draft;
  return conversation;
}

function setAssistantDraft(item, draft) {
  const conversation = ensureAssistantData(item);
  conversation.draft = draft;
  item.chatDraft = draft;
}

const REFINE_PRESETS = [
  "Group steps into labeled stages",
  "Remove redundant or accidental steps",
  "Add stability waits around page transitions",
  "Add assertions for key outcomes",
  "Move repeated text inputs into Reference variables",
];

// 已勾选预设 → 可移除 chips（局部刷新，不触发面板重渲染）。
function renderRefineChips(quickHost, state) {
  const chipsHost = quickHost.querySelector("[data-refine-chips]");
  if (!chipsHost) return;
  const indices = state.aiRefinePresetIndices || [];
  chipsHost.hidden = !indices.length;
  chipsHost.replaceChildren(
    ...indices.map((index) => {
      const chip = rowTemplate("chatChipTemplate").cloneNode(true);
      chip.textContent = REFINE_PRESETS[index];
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "chip-remove";
      remove.setAttribute("aria-label", "Remove preset " + REFINE_PRESETS[index]);
      remove.textContent = "×";
      remove.onclick = () => {
        state.aiRefinePresetIndices = (state.aiRefinePresetIndices || []).filter(
          (i) => i !== index,
        );
        const input = quickHost.querySelector(
          `input[data-refine-preset="${index}"]`,
        );
        if (input) input.checked = false;
        renderRefineChips(quickHost, state);
      };
      chip.appendChild(remove);
      return chip;
    }),
  );
}

// Test 失败预设项：点击才把失败上下文发给 AI（复用 replayFailure 默认文案）。
function analyzeLastFailure() {
  const recording = currentAssistantItem();
  if (!recording) return;
  const results = recording.testResults || [];
  const failedSteps = results
    .map((result, index) => ({ index, ...(result || {}) }))
    .filter((entry) => entry.status === "fail");
  if (!failedSteps.length) return;
  void startAIAdvice({
    mode: "replay-failure",
    items: [recording],
    failureContext: { ok: false, failedSteps, allResults: results },
  });
}

function submitRefineOptions() {
  const state = recordingSession();
  // 勾选态存在 state（aiRefinePresetIndices），DOM 重建不丢；提交时组装
  // 多行结构化指令：每勾选项一行 “- <preset>”，空行后跟自由文本。
  const presets = (state.aiRefinePresetIndices || [])
    .map((index) => REFINE_PRESETS[index])
    .filter(Boolean);
  const freeText = $("refineFreeText")?.value.trim() || "";
  const instruction =
    [
      presets.length ? presets.map((preset) => `- ${preset}`).join("\n") : "",
      freeText,
    ]
      .filter(Boolean)
      .join("\n\n") ||
    "Sanitize and structure the selected material(s) into labeled stages, removing redundant or accidental steps.";
  state.aiMode = undefined;
  state.aiRefineFormBuilt = false;
  // 提交时的显式来源：打开菜单时的勾选快照（一次性使用后清空）。
  const refineSources = state.aiRefineSources || [];
  state.aiRefineSources = [];
  invokeAIMerge("input", instruction, {
    forceMaterial: true,
    refinePresets: presets,
    refineText: freeText,
    refineSources,
  });
}

/* ---------------- @ 提及与附件（录制 id 进 UI 状态，Flow 载荷只在主进程组装） ---------------- */

function aiAttachmentItems(ids) {
  const state = recordingSession();
  const list = Array.isArray(ids) ? ids : state.aiAttachments || [];
  const resolved = [];
  for (const id of list) {
    const item = (state.items || []).find((entry) => (entry.recordingId || entry.id) === id);
    if (item && !resolved.includes(item)) resolved.push(item);
  }
  return resolved;
}

function renderAttachmentChips() {
  const state = recordingSession();
  const box = $("assistantAttachments");
  if (!box) return;
  const items = aiAttachmentItems();
  box.replaceChildren(
    ...items.map((item) => {
      const chip = rowTemplate("attachmentChipTemplate").cloneNode(true);
      chip.querySelector("[data-chip-name]").textContent = "@" + item.name;
      const remove = chip.querySelector("[data-attachment-remove]");
      remove.dataset.attachmentRemove = item.recordingId || item.id;
      remove.setAttribute(
        "aria-label",
        "Remove attachment " + item.name,
      );
      return chip;
    }),
  );
  box.hidden = items.length === 0;
  box.onclick = (e) => {
    const remove = e.target.closest("[data-attachment-remove]");
    if (!remove) return;
    state.aiAttachments = (state.aiAttachments || []).filter((id) => id !== remove.dataset.attachmentRemove);
    renderAttachmentChips();
  };
}

const mentionPickerState = { open: false, items: [], active: 0, tokenStart: 0, caret: 0 };

function mentionCandidates(query) {
  const state = recordingSession();
  const q = String(query || "").toLowerCase();
  return (state.items || [])
    .filter((item) => item.name && (!q || String(item.name).toLowerCase().includes(q)))
    .slice(0, 8);
}

function mentionQueryAtCaret(input) {
  if (!input) return null;
  const caret = input.selectionStart ?? input.value.length;
  if (caret !== input.selectionEnd) return null;
  const before = input.value.slice(0, caret);
  const match = before.match(/(^|\s)@([\w.\-À-ɏ㐀-鿿]*)$/u);
  if (!match) return null;
  return { tokenStart: caret - match[2].length - 1, query: match[2], caret };
}

function mentionOptionNode(item, index) {
  const option = rowTemplate("mentionOptionTemplate").cloneNode(true);
  const active = index === mentionPickerState.active;
  option.classList.toggle("active", active);
  option.dataset.mentionIndex = index;
  option.setAttribute("aria-selected", String(active));
  option.querySelector(".mention-name").textContent = item.name;
  const badge = item.summary ? "Refined" : item.recorded ? "Record" : "";
  option.querySelector(".mention-badge.refined").hidden = badge !== "Refined";
  option.querySelector(".mention-badge.record").hidden = badge !== "Record";
  return option;
}

function updateMentionPicker(input) {
  const picker = $("mentionPicker");
  if (!picker) return;
  const at = mentionQueryAtCaret(input);
  const items = at ? mentionCandidates(at.query) : [];
  mentionPickerState.open = items.length > 0;
  mentionPickerState.items = items;
  mentionPickerState.active = 0;
  if (at) {
    mentionPickerState.tokenStart = at.tokenStart;
    mentionPickerState.caret = at.caret;
  }
  picker.hidden = !mentionPickerState.open;
  if (mentionPickerState.open) {
    picker.replaceChildren(
      ...items.map((item, index) => mentionOptionNode(item, index)),
    );
    picker.setAttribute("aria-expanded", "true");
  } else {
    picker.replaceChildren();
    picker.setAttribute("aria-expanded", "false");
  }
}

function closeMentionPicker() {
  mentionPickerState.open = false;
  mentionPickerState.items = [];
  mentionPickerState.active = 0;
  const picker = $("mentionPicker");
  if (picker) {
    picker.hidden = true;
    picker.replaceChildren();
    picker.setAttribute("aria-expanded", "false");
  }
}

function chooseMention(item) {
  const state = recordingSession();
  const id = item.recordingId || item.id;
  state.aiAttachments ??= [];
  if (!state.aiAttachments.includes(id)) state.aiAttachments.push(id);
  const input = $("assistantInput");
  if (input) {
    input.value = input.value.slice(0, mentionPickerState.tokenStart) + input.value.slice(mentionPickerState.caret);
    setAssistantDraft(currentAssistantContext(), input.value);
  }
  const caret = mentionPickerState.tokenStart;
  closeMentionPicker();
  renderAIPanel();
  const restored = $("assistantInput");
  if (restored) {
    restored.focus();
    try {
      restored.setSelectionRange(caret, caret);
    } catch {
      /* textarea 支持.setSelectionRange；防御性忽略 */
    }
  }
}

function bindMentionPicker() {
  const picker = $("mentionPicker");
  if (!picker) return;
  picker.onclick = (e) => {
    const option = e.target.closest("[data-mention-index]");
    if (!option) return;
    const item = mentionPickerState.items[Number(option.dataset.mentionIndex)];
    if (item) chooseMention(item);
  };
}

let aiPrewarmFired = false;
// AI 面板一打开就请求主进程预热 Pi（SDK 导入 + 运行时缓存）；只发一次，
// 之后的首条消息只剩会话创建与网络往返。
function prewarmPiOnce() {
  if (aiPrewarmFired) return;
  aiPrewarmFired = true;
  window.flowlink?.pi?.prewarm?.().catch(() => {});
}

function renderAIPanel() {
  // 分析后助手上下文关联到具体录制项，分析前则关联到操作指南。
  // 是否显示由当前 Design 标签页和 aiOpen 状态共同决定。
  const state = recordingSession(),
    recording = currentAssistantItem(),
    item = currentAssistantContext(),
    testTab = recording?.resultTab === "Test",
    open = drawerView === "Design" && state.aiOpen;
  // refine-options 是一次性模式：面板关闭或 refine 来源快照丢失时还原为普通面板。
  if (state.aiMode === "refine-options" && (!open || !state.aiRefineSources?.length))
    state.aiMode = undefined;
  const refineOptions = state.aiMode === "refine-options";
  if (!refineOptions && state.aiRefineFormBuilt) {
    // 离开 refine 模式即丢弃表单痕迹，下次进入重新构建（勾选态同步清空）。
    state.aiRefineFormBuilt = false;
    state.aiRefinePresetIndices = [];
  }
  // 快捷菜单状态位：切页/切换工作流（上下文键变化）时复位，
  // merge/generate/optimize 只由 Refine 按钮触发出现。
  const menuContext = `${recording?.id || ""}|${state.view || ""}|${recording?.resultTab || ""}`;
  if (state.refineMenuContext !== menuContext) {
    state.refineMenuContext = menuContext;
    state.refineMenuOpen = false;
  }
  $("drawer").classList.toggle("ai-open", !!open);
  $("recordingAssistant").hidden = !open;
  $("aiToggle")?.setAttribute("aria-expanded", String(!!open));
  $("recordingAssistant").classList.toggle("has-test-steps", testTab);
  $("executionMonitor").hidden = !testTab || !open;
  const testShell = recordingSession().workspaceElement?.querySelector(
    ".test-tab-shell",
  );
  testShell?.classList.toggle("has-visible-ai-dock", testTab && !open);
  if (!open) return;
  prewarmPiOnce();
  ensureAssistantData(item);
  // pending 恢复：AI 面板打开时按需查一次未决议 pending（文件是事实源，
  // 不依赖 Process 标签页）；pendingLoaded 由 ai:pending 事件与生成方置脏。
  if (
    recording?.recordingId &&
    recording.flowFile &&
    !recording.pendingLoaded &&
    !recording.pendingLoading
  ) {
    void hydratePendingUpdate(recording).then(() => {
      if (currentAssistantItem() === recording && recordingSession().aiOpen)
        renderAIPanel();
    });
  }
  bindAssistantResize();
  $("assistantFileName").textContent = "AI Assistant";
  $("assistantClose").onclick = () => {
    state.aiOpen = false;
    renderAIPanel();
    $("aiToggle")?.focus();
  };
  $("assistantSteps").setAttribute(
    "aria-label",
    testTab ? "Test steps" : "Recording steps",
  );
  const selectedGroup =
    recording?.analyzed && state.view === "analysis"
      ? ensureProcessGroups(recording).find(
          (group) => group.id === recording.selectedGroup,
        )
      : null;
  $("recordingAssistant").classList.toggle(
    "has-group-context",
    !!selectedGroup && !testTab,
  );
  const stepsHost = $("assistantSteps");
  const quickHost = $("assistantQuickActions");
  const showOptions = !!(
    state.refineMenuOpen &&
    !refineOptions &&
    !testTab &&
    !selectedGroup
  );
  stepsHost.querySelector('[data-ai-block="steps"]').hidden = !showOptions;
  stepsHost.querySelector('[data-ai-block="test"]').hidden = !testTab;
  stepsHost.querySelector('[data-ai-block="group"]').hidden = !(
    selectedGroup && !testTab
  );
  // 统一快捷区：控件保留原 id（按 id 绑定的逻辑不动），只随原区块的
  // 显隐条件在快捷区内切换对应分组。
  quickHost.querySelector('[data-quick-block="options"]').hidden = !showOptions;
  quickHost.querySelector('[data-quick-block="refine"]').hidden = !refineOptions;
  quickHost.querySelector('[data-quick-block="group"]').hidden = !(
    selectedGroup && !testTab
  );
  if (refineOptions) {
    const count = state.aiRefineSources?.length || 0;
    quickHost.querySelector(".assistant-refine-title").textContent =
      "Refine " +
      (count === 1 ? "1 selected material" : count + " selected materials");
    // 表单 DOM 只在进入 refine 模式时构建一次：输入期间任何重渲染都不重建
    // 勾选/文本 DOM（勾选态存 state，chips 局部刷新），修复“输入重置勾选”。
    if (!state.aiRefineFormBuilt) {
      state.aiRefineFormBuilt = true;
      state.aiRefinePresetIndices = [];
      const presetsHost = quickHost.querySelector("[data-refine-presets]");
      presetsHost.replaceChildren(
        ...REFINE_PRESETS.map((preset, index) => {
          const label = rowTemplate("refinePresetTemplate").cloneNode(true);
          const input = label.querySelector("input");
          input.dataset.refinePreset = index;
          label.querySelector("span").textContent = preset;
          return label;
        }),
      );
      presetsHost.onchange = (e) => {
        const input = e.target.closest("input[data-refine-preset]");
        if (!input) return;
        const index = Number(input.dataset.refinePreset);
        const set = new Set(state.aiRefinePresetIndices || []);
        if (input.checked) set.add(index);
        else set.delete(index);
        state.aiRefinePresetIndices = [...set].sort((a, b) => a - b);
        renderRefineChips(quickHost, state);
      };
      quickHost.querySelector("#refineFreeText").value = "";
      renderRefineChips(quickHost, state);
    }
  }
  // 未决议 pending 快捷块：Confirm / Discard（存在时显示，来源与版本进 tooltip）。
  const pendingUpdate = recording?.pendingUpdate?.flow ? recording.pendingUpdate : null;
  const pendingBlock = quickHost.querySelector('[data-quick-block="pending"]');
  if (pendingBlock) {
    pendingBlock.hidden = !pendingUpdate;
    if (pendingUpdate) {
      const created = pendingUpdate.createdAt
        ? new Date(pendingUpdate.createdAt).toLocaleString()
        : "";
      pendingBlock.title = `${pendingSourceText(pendingUpdate.source)} · ${created} · 基于 v${pendingUpdate.baseVersion}，确认后成为 v${pendingUpdate.baseVersion + 1}`;
    }
  }
  if (testTab) {
    const testSteps = recording?.testFlowSteps?.length
      ? recording.testFlowSteps
      : recording?.steps || [];
    const results = recording?.testResults || [];
    stepsHost.querySelector(".test-progress-heading span").textContent =
      results.filter((result) => result?.status === "pass").length +
      " / " +
      testSteps.length;
    // 修复链自动回跑轮次（REPAIRED 后自动 Test，最多 2 轮；见 bridge.js）
    const roundHeading = stepsHost.querySelector(".test-progress-heading");
    let roundNote = roundHeading.querySelector(".test-round-note");
    if (recording?.autoVerifyRound) {
      if (!roundNote) {
        roundNote = document.createElement("span");
        roundNote.className = "test-round-note";
        roundHeading.appendChild(roundNote);
      }
      roundNote.textContent = `· 自动回跑 ${recording.autoVerifyRound}/2`;
    } else if (roundNote) {
      roundNote.remove();
    }
    // 未决议 pending 提示（Test 侧）：本次测试基于当前版本；测试后的自动修复
    // 直接落盘（version+1）。决议入口在 AI 面板快捷区。
    let proposalNote = roundHeading.querySelector(".test-proposal-note");
    if (recording?.pendingUpdate?.flow) {
      if (!proposalNote) {
        proposalNote = document.createElement("span");
        proposalNote.className = "test-round-note test-proposal-note";
        roundHeading.appendChild(proposalNote);
      }
      proposalNote.textContent = "· 有待确认更新";
      proposalNote.title =
        "存在待确认的 AI 流程更新：本次测试基于当前正式版本；请在 AI 面板 Confirm 或 Discard（若期间发生手工编辑，Confirm 会被拒绝并要求重新生成）。";
    } else if (proposalNote) {
      proposalNote.remove();
    }
    const list = stepsHost.querySelector(".assistant-test-steps");
    stepsHost.querySelector("[data-test-empty]").hidden = !!testSteps.length;
    // 进度列表分组化：组标题行（编号+名称+组级状态）+ 组内步骤行；
    // 分支未走的组整节淡化并标 "Skipped · 分支未走"，与 Process 图上的组对应。
    list.replaceChildren(
      ...testProgressGroups(recording).map((section) => {
        const status = testGroupStatus(section.rows);
        const node = rowTemplate("testGroupTemplate").cloneNode(true);
        node.classList.add("status-" + status);
        node.querySelector(".test-group-number").textContent = section.number;
        node.querySelector(".test-group-name").textContent = section.name;
        const statusChip = node.querySelector(".test-group-status");
        const label =
          status === "pass"
            ? "✓"
            : status === "fail"
              ? "✗"
              : status === "running"
                ? "▶ Running"
                : status === "skipped"
                  ? "Skipped · 分支未走"
                  : "";
        statusChip.hidden = !label;
        statusChip.textContent = label;
        node.querySelector(".test-group-rows").replaceChildren(
          ...section.rows.map((row) =>
            testStepNode(row.step, row.index, row.result),
          ),
        );
        return node;
      }),
    );
    // Test 失败后的 AI 预设项（替代旧自动发消息 + #aiContinueTest 独立按钮）：
    // 「Analyze last failure」点击才把失败上下文发给 AI；「AI Continue」点击
    // 触发单步接管循环（runAiAssistedTest：只执行失败步后回到程序回放）。
    // 仅存在失败结果且无运行中的回放/接管时可用。
    const failureBlock = quickHost.querySelector('[data-quick-block="failure"]');
    if (failureBlock) {
      const hasFail = results.some((result) => result?.status === "fail");
      const canAssist = !!(
        recording?.recordingId &&
        hasFail &&
        !recording.testRunning &&
        !recording.assistedLoopActive &&
        !state.playbackInFlight
      );
      failureBlock.hidden = !canAssist;
    }
  } else {
    quickHost.querySelector('[data-quick-block="failure"]').hidden = true;
  }
  if (selectedGroup && !testTab)
    stepsHost.querySelector(".assistant-group-name").textContent =
      selectedGroup.number + " " + selectedGroup.name;
  if (showOptions)
    stepsHost.querySelector('[data-ai-block="steps"]').replaceChildren(
      ...item.steps.map((step, index) => {
        const node = rowTemplate("assistantStepTemplate").cloneNode(true);
        node.querySelector(".assistant-step-number").textContent =
          "Step " + (index + 1) + ":";
        node.querySelector("[data-step-text]").textContent = step;
        return node;
      }),
    );
  const continueButton = $("refineContinue");
  if (continueButton) continueButton.onclick = submitRefineOptions;
  // 快捷区整体在无任何可用控件时隐藏（Test 运行中等场景）。
  quickHost.hidden = !Array.from(quickHost.children).some(
    (child) => !child.hidden,
  );
  quickHost.onclick = (e) => {
    const pendingButton = e.target.closest("[data-pending-action]");
    if (pendingButton) {
      e.preventDefault();
      if (!recording?.recordingId) return;
      if (pendingButton.dataset.pendingAction === "confirm")
        void confirmPendingUpdate(recording);
      else void discardPendingUpdate(recording);
      return;
    }
    const failureButton = e.target.closest("[data-ai-failure]");
    if (failureButton) {
      e.preventDefault();
      if (failureButton.dataset.aiFailure === "analyze") analyzeLastFailure();
      else if (typeof window.runAiAssistedTest === "function")
        void window.runAiAssistedTest(recording);
      return;
    }
    if (testTab) return;
    const option = e.target.closest("[data-ai-option]");
    if (option) {
      e.preventDefault();
      // Optimize 二级展开：进入预设勾选+自由文本表单；merge/generate 走各自现有流程。
      if (option.dataset.aiOption === "optimize") {
        state.aiMode = "refine-options";
        renderAIPanel();
      } else {
        invokeAIMerge(option.dataset.aiOption);
      }
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

  $("assistantChat").replaceChildren(
    ...item.chat.map((message) => {
      // 聊天记录只存文本 + 预设/附件徽章；Flow JSON 永不进入 transcript。
      const element = rowTemplate("assistantMessageTemplate").cloneNode(true);
      element.classList.add(message.role);
      element.setAttribute(
        "aria-label",
        message.role === "user" ? "User" : "AI",
      );
      const chipsHost = element.querySelector(".message-attachments");
      // 失败消息：完整错误文本（阶段+原因）以可折叠详情呈现，不再要求查日志。
      if (message.errorDetail) {
        const details = document.createElement("details");
        details.className = "message-error-details";
        const summary = document.createElement("summary");
        summary.textContent = message.text;
        const pre = document.createElement("pre");
        pre.textContent = message.errorDetail;
        details.append(summary, pre);
        element.insertBefore(details, element.firstChild);
      } else if (
        message.role === "user" &&
        Array.isArray(message.presets) &&
        message.presets.length
      ) {
        chipsHost.replaceChildren(
          ...message.presets.map((preset) => {
            const chip = rowTemplate("chatChipTemplate").cloneNode(true);
            chip.textContent = preset;
            return chip;
          }),
        );
        element.insertBefore(chipsHost, element.firstChild);
        element.insertBefore(
          document.createTextNode(message.text),
          chipsHost.nextSibling,
        );
      } else {
        element.insertBefore(
          document.createTextNode(message.text),
          element.firstChild,
        );
      }
      if (
        message.role === "user" &&
        Array.isArray(message.attachments) &&
        message.attachments.length
      ) {
        const attachmentsHost = element.querySelector(".message-attachments");
        if (!attachmentsHost.hasChildNodes()) {
          attachmentsHost.replaceChildren(
            ...message.attachments.map((attachment) => {
              const chip = rowTemplate("chatChipTemplate").cloneNode(true);
              chip.textContent = "@" + attachment.name;
              return chip;
            }),
          );
          element.appendChild(attachmentsHost);
        }
      }
      return element;
    }),
  );
  $("assistantContent").scrollTop = $("assistantContent").scrollHeight;
  renderAttachmentChips();
  closeMentionPicker();
  bindMentionPicker();
  $("assistantInput").placeholder = "Ask anything...";
  $("assistantInput").value = item.chatDraft;
  $("assistantInput").disabled = false;
  // Test 运行中 composer 发送键兼作 Stop（Run/Stop 工具栏已移除，对齐原型）。
  const testRunning = testTab && !!recording?.testRunning;
  const sendButton = $("assistantSend");
  sendButton.disabled = testRunning ? false : !item.chatDraft.trim();
  sendButton.onclick = testRunning
    ? () => {
        if (recording && window.stopFlowlinkTest)
          window.stopFlowlinkTest(recording);
      }
    : submitAssistantMessage;
  sendButton.setAttribute("aria-label", testRunning ? "Stop" : "发送");
  sendButton.title = testRunning ? "Stop" : "发送";
  setIconHidden(sendButton.querySelector("[data-send-icon]"), testRunning);
  setIconHidden(sendButton.querySelector("[data-stop-icon]"), !testRunning);
  $("assistantInput").oninput = (e) => {
    setAssistantDraft(item, e.target.value);
    if (!testRunning) $("assistantSend").disabled = !item.chatDraft.trim();
    updateMentionPicker(e.target);
  };
  $("assistantInput").onkeydown = (e) => {
    if (mentionPickerState.open && mentionPickerState.items.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        const count = mentionPickerState.items.length;
        mentionPickerState.active = (mentionPickerState.active + delta + count) % count;
        $("mentionPicker").replaceChildren(
          ...mentionPickerState.items.map((item, index) =>
            mentionOptionNode(item, index),
          ),
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        chooseMention(mentionPickerState.items[mentionPickerState.active]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeMentionPicker();
        return;
      }
    }
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

async function aiMaterialContext(items) {
  const result = [];
  for (const [index, item] of (items || []).entries()) {
    let executableFlow = null;
    if (item.flowFile && window.flowlink?.flow?.load) {
      try { executableFlow = await window.flowlink.flow.load(item.flowFile); } catch (error) { console.warn("Could not load Flow context for AI", error); }
    }
    result.push({
      sourceIndex: index + 1,
      id: item.id,
      name: item.name,
      url: item.url,
      steps: executableFlow?.steps || item.steps,
      flowMeta: executableFlow ? { id: executableFlow.id, title: executableFlow.title, meta: executableFlow.meta, variables: executableFlow.variables } : undefined,
      stepDetails: item.stepDetails,
      processGroups: item.processGroups,
      testResults: item.testResults,
      testFlowSteps: item.testFlowSteps,
      recordingId: item.recordingId,
      sourceIds: item.sourceIds,
    });
  }
  return result;
}

/** advice 回复的意图标注解析：行级提取 `INTENT=refine|advice` 并从展示文本
 * 剥离该行（模板要求正文后另起一行输出）。提取失败返回 intent:null，
 * 调用方按 advice 呈现并追加兜底提示句。 */
function parseAdviceIntent(rawText) {
  const lines = String(rawText || "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].trim().match(/^INTENT=(refine|advice)\s*$/i);
    if (match) {
      lines.splice(i, 1);
      return { text: lines.join("\n").trim(), intent: match[1].toLowerCase() };
    }
  }
  return { text: String(rawText || "").trim(), intent: null };
}

function appendAIMessage(item, role, text, extra = {}) {
  ensureAssistantData(item);
  item.chat.push({ role, text: String(text || ""), ...extra });
  setAssistantDraft(item, "");
  renderAIPanel();
}

let piPromptTemplatesCache = null;
async function piPromptTemplates() {
  if (piPromptTemplatesCache) return piPromptTemplatesCache;
  const bridge = window.flowlink?.pi;
  if (!bridge?.promptTemplates) throw new Error("FlowLink Pi prompt templates are unavailable.");
  const templates = await bridge.promptTemplates();
  if (!templates?.advice?.prompt || !templates.advice.defaults) {
    throw new Error("FlowLink Pi prompt templates are incomplete; check config/prompts.json.");
  }
  piPromptTemplatesCache = templates;
  return templates;
}

function formatPiTemplate(template, values) {
  return String(template || "").replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const value = values[key];
    if (typeof value !== "string") {
      throw new Error(`Pi prompt template references {{${key}}}, but no value was provided.`);
    }
    return value;
  });
}

/** 兜底提示句：模型未输出可解析的 INTENT 标注时由渲染层固定追加，保证用户
 * 永远有下一步可走（堵死“想生成却只得到建议”的循环）。 */
const ADVICE_INTENT_FALLBACK_HINT =
  "如需直接生成新版本，请明确说明或使用 Refine 表单。";

async function askPiForAdvice(item, sourceItems, userRequest, mode, extraContext = {}) {
  const bridge = window.flowlink?.pi;
  if (!bridge?.prompt) throw new Error("FlowLink Pi SDK bridge is unavailable.");
  const templates = await piPromptTemplates();
  const context = await aiMaterialContext(sourceItems?.length ? sourceItems : [item]);
  const prompt = formatPiTemplate(templates.advice.prompt, {
    mode,
    conversation: JSON.stringify((item.chat || []).slice(-8).map((message) => ({ role: message.role, text: message.text })).slice(0, 8)).slice(0, 12000),
    userRequest: userRequest || "Review this material and suggest improvements.",
    materialContext: JSON.stringify(context).slice(0, 65000),
    executionContext: Object.keys(extraContext).length ? `Execution context JSON:\n${JSON.stringify(extraContext).slice(0, 25000)}` : "",
  }).trim();
  const result = await bridge.prompt({ prompt, timeoutMs: 120000 });
  return parseAdviceIntent(result.text);
}

async function generateRefinedMaterial(sourceItems, request, parentItem) {
  const sources = sourceItems?.length ? sourceItems : [parentItem].filter(Boolean);
  if (!sources.length) throw new Error("Select at least one material to refine.");
  const bridge = window.flowlink?.pi;
  if (!bridge?.generateFlow)
    throw new Error("FlowLink Pi generation bridge is unavailable. Run inside FlowLink with the preload API to generate refined materials.");
  const recordingIds = sources.map((source) => source.recordingId).filter(Boolean);
  if (!recordingIds.length || recordingIds.length !== sources.length)
    throw new Error("The selected material has no saved executable Flow. Advice is available, but a replayable refined material cannot be saved yet.");
  const taskCode = currentFlow?.code || activeFlowKey;
  const conversation = (parentItem?.chat || [])
    .slice(-8)
    .map((message) => ({ role: message.role, text: message.text }));
  // 投影、提示词组装、$ref 再水化与 schema 校验都在主进程完成；渲染层只传
  // 录制 id 和纯文本对话，聊天与 Flow 载荷互不沾染。
  const result = await bridge.generateFlow({ taskCode, recordingIds, instruction: request, conversation });
  // 分流（REFINED 单线演进）：唯一来源是已有 REFINED 记录时，AI 的修改暂存为
  // 该记录的 pending 更新（单槽覆盖），AI 面板 Confirm / Discard 决议；
  // 多来源合并或原始 Record → 生成新 REFINED 条目。
  if (sources.length === 1 && sources[0].summary && sources[0].recordingId) {
    const target = sources[0];
    const saved = await window.flowlink.flow.stagePending({
      taskCode,
      recordingId: target.recordingId,
      source: "refine",
      flow: result.flow,
      summary: result.summary || "",
      risks: Array.isArray(result.risks) ? result.risks : [],
    });
    // 变更清单：复用 diff 函数对比正式版本与待确认版本，中文文本随消息呈现。
    let changeList = "";
    if (target.flowFile) {
      try {
        const currentFlow = await window.flowlink.flow.load(target.flowFile);
        changeList = describePendingChanges(currentFlow, result.flow);
      } catch (error) {
        console.warn("[refine] 待确认更新变更清单生成失败：", error);
      }
    }
    const proposalState = recordingSession();
    target.pendingLoaded = false;
    proposalState.focused = target.id;
    proposalState.view = "analysis";
    proposalState.stage = "done";
    proposalState.aiOpen = true;
    renderRecordingWorkspace();
    renderAIPanel();
    appendAIMessage(
      target,
      "assistant",
      `已生成待确认的新版本 v${saved.baseVersion + 1}，确认后生效` +
        (saved.overwrote ? "（已覆盖上一版未确认修改）" : "") +
        "。可在此面板 Confirm / Discard。" +
        (changeList ? `\n\n本版变更：\n${changeList}` : "") +
        `\n\n理由：\n${(Array.isArray(result.rationale) ? result.rationale : []).join("\n- ") || "见生成的步骤。"}` +
        `\n\n风险 / 需验证：\n${(Array.isArray(result.risks) ? result.risks : []).join("\n- ") || "Confirm 前建议先跑一次 Test。"}`,
    );
    return target;
  }
  const flow = result.flow;
  const recording = await window.flowlink.recording.persistMerged({ taskCode, flow, name: result.title || flow.title });
  const refined = {
    ...sources[0],
    id: recording.id,
    name: recording.name,
    recordingId: recording.id,
    flowFile: recording.flowFile,
    artifactsDir: recording.artifactsDir,
    url: flow.meta?.env?.startUrl || sources[0].url,
    checked: false,
    summary: true,
    recorded: false,
    analyzed: true,
    sourceIds: sources.flatMap((source) => source.sourceIds || [source.id]),
    steps: flow.steps.map((step, index) => `${step.kind || "action"}${step.url ? ` · ${step.url}` : step.value ? ` · ${step.value}` : step.target?.candidates?.[0]?.value ? ` · ${step.target.candidates[0].value}` : ` · Step ${index + 1}`}`),
    stepDetails: sources[0].stepDetails || [],
    processGroups: undefined,
    references: [],
    resultTab: "Process",
    aiRationale: Array.isArray(result.rationale) ? result.rationale : [],
    aiRisks: Array.isArray(result.risks) ? result.risks : [],
  };
  const state = recordingSession();
  state.items.push(refined);
  state.focused = refined.id;
  state.view = "analysis";
  state.stage = "done";
  rebuildItemTestFlow(refined);
  renderRecordingWorkspace();
  state.aiOpen = true;
  renderAIPanel();
  appendAIMessage(refined, "assistant", `Created a new refined material: ${refined.name}. The original material was preserved.\n\nRationale:\n${refined.aiRationale.join("\n- ") || "See the generated steps."}\n\nRisks / items to verify:\n${refined.aiRisks.join("\n- ") || "Run a replay test before relying on this material."}`);
  return refined;
}

async function invokeAIMerge(option, prompt, extra = {}) {
  const state = recordingSession(),
    recording = currentAssistantItem(),
    item = currentAssistantContext();
  ensureAssistantData(item);
  const optionLabels = {
    merge: "Merge selected recordings",
    generate: "Generate flow from description",
    optimize: "Review and refine current material",
    input: prompt || "User request",
  };
  const userText = prompt || optionLabels[option] || option;
  // 附件只在本次消息里生效：聊天条目存 id/name 芯片，发送后即清空。
  const attachmentItems = aiAttachmentItems(extra.attachments);
  state.aiAttachments = [];
  item.chat.push({
    role: "user",
    text: userText,
    ...(Array.isArray(extra.refinePresets) && extra.refinePresets.length
      ? { presets: extra.refinePresets }
      : {}),
    ...(attachmentItems.length
      ? {
          attachments: attachmentItems.map((entry) => ({
            id: entry.recordingId || entry.id,
            name: entry.name,
          })),
        }
      : {}),
  });
  setAssistantDraft(item, "");
  renderAIPanel();

  // Refine 按钮/表单路径：必定生成，不经意图判定；来源 = 打开菜单时的勾选快照，
  // 快照缺失时回退 @ 附件 > 当前打开。
  if (extra.forceMaterial) {
    const refineSources = extra.refineSources?.length
      ? extra.refineSources
      : attachmentItems.length
        ? attachmentItems
        : recording?.analyzed
          ? [recording]
          : item !== state.guideAssistant && item.analyzed
            ? [item]
            : [];
    try {
      item.chat.push({ role: "assistant", text: "Pi is preparing a separate refined material. The original recording will not be overwritten…" });
      renderAIPanel();
      await generateRefinedMaterial(refineSources, userText, recording || item);
    } catch (error) {
      // 完整错误文本（含阶段+原因）随 errorDetail 透出，面板可折叠查看。
      const full = error instanceof Error ? error.message : String(error);
      appendAIMessage(
        item,
        "assistant",
        "Could not create refined material — 展开查看完整错误详情。",
        { errorDetail: full },
      );
    }
    return;
  }

  // 聊天路径：意图判定并入 advice 调用（本地不做关键字正则判定）。
  // advice 上下文来源：@ 附件 > 当前打开的录制。
  const chatSources = attachmentItems.length
    ? attachmentItems
    : recording?.analyzed
      ? [recording]
      : item !== state.guideAssistant && item.analyzed
        ? [item]
        : [];
  const replaceLast = (text) => {
    const last = item.chat[item.chat.length - 1];
    if (last?.role === "assistant" && last.text.startsWith("Pi is reviewing")) last.text = text;
    else item.chat.push({ role: "assistant", text });
    renderAIPanel();
  };
  try {
    item.chat.push({ role: "assistant", text: "Pi is reviewing the recording evidence…" });
    renderAIPanel();
    const { text: answer, intent } = await askPiForAdvice(
      item,
      chatSources,
      userText,
      state.aiTaskMode || (recording?.resultTab === "Test" ? "replay-failure" : "material-refinement"),
      state.aiFailureContext || {},
    );
    if (intent === "refine") {
      // 生成来源匹配：@ 引用 > 当前打开；两者皆无 → AI 列出候选录制名请用户 @ 回复。
      const refineTargets = attachmentItems.length
        ? attachmentItems
        : recording?.analyzed && recording.recordingId
          ? [recording]
          : null;
      if (!refineTargets) {
        const saved = (state.items || []).filter((entry) => entry.recordingId);
        replaceLast(
          saved.length
            ? `${answer}\n\n可以直接生成新版本。请 @ 引用要细化的录制后重发：\n${saved
                .map((entry) => "- @" + entry.name)
                .join("\n")}`
            : "当前任务还没有已保存的可回放录制，暂无可细化的对象。请先完成录制并分析。",
        );
        return;
      }
      replaceLast(`${answer}\n\n正在按上述意见生成新版本…`);
      try {
        await generateRefinedMaterial(refineTargets, userText, recording || item);
      } catch (error) {
        const full = error instanceof Error ? error.message : String(error);
        appendAIMessage(
          item,
          "assistant",
          "Could not create refined material — 展开查看完整错误详情。",
          { errorDetail: full },
        );
      }
      return;
    }
    // advice（含解析失败回退）：解析失败时固定追加兜底提示句。
    replaceLast(
      intent === "advice"
        ? answer
        : `${answer}\n\n${ADVICE_INTENT_FALLBACK_HINT}`,
    );
  } catch (error) {
    appendAIMessage(item, "assistant", `Pi could not respond: ${error instanceof Error ? error.message : String(error)}. Check Pi model/provider configuration and try again.`);
  }
}

async function startAIAdvice({ mode, items, reason, failureContext } = {}) {
  const state = recordingSession();
  // 失败回放的诊断可能在用户关闭本 taskflow、切到新的 taskflow 之后才返回；
  // recordingSession() 会解析成新会话。会话守卫：只有发起时的会话仍是当前会话
  // 才允许改焦点/打开 AI 面板/触发渲染，否则只把消息留在源录制项的聊天里。
  const stillCurrent = () => recordingSession() === state;
  const sources = (items || []).filter(Boolean);
  if (!sources.length) return;
  const item = sources[0];
  // 失败回放的诊断可能在用户已切到其他 taskflow 后才触发/返回：此时
  // recordingSession() 解析成新会话，而 sources 属于旧会话。只把消息留在源
  // 录制项的聊天里，绝不改当前会话的焦点/AI 面板/渲染。
  const ownsSource = state.items.includes(item) || item === state.guideAssistant;
  if (!ownsSource || !stillCurrent()) {
    (item.chat ??= []).push({
      role: "assistant",
      text: "Replay diagnosis arrived after this taskflow was closed; reopen it to review.",
    });
    return;
  }
  state.aiTaskMode = mode || "material-refinement";
  state.aiFailureContext = failureContext || {};
  state.focused = sources[0].id;
  state.view = "analysis";
  state.stage = state.stage === "recording" ? "done" : state.stage;
  state.aiOpen = true;
  ensureAssistantData(item);
  renderRecordingWorkspace();
  renderAIPanel();
  const templates = await piPromptTemplates();
  const adviceDefaults = templates.advice.defaults;
  const prompt = reason || (mode === "recording-complete"
    ? adviceDefaults.recordingComplete
    : mode === "replay-failure"
      ? adviceDefaults.replayFailure
      : adviceDefaults.materialRefinement);
  item.chat.push({ role: "assistant", text: "Pi is analyzing the recording evidence…" });
  if (stillCurrent()) renderAIPanel();
  try {
    // 显式建议入口（预设/失败诊断）：剥离 INTENT 标注行后按建议呈现，不做 refine 分流。
    const { text: answer } = await askPiForAdvice(item, sources, prompt, state.aiTaskMode, failureContext || {});
    const last = item.chat[item.chat.length - 1];
    if (last?.role === "assistant" && last.text.startsWith("Pi is analyzing")) last.text = answer;
    else item.chat.push({ role: "assistant", text: answer });
  } catch (error) {
    const last = item.chat[item.chat.length - 1];
    const message = `Pi could not analyze this material: ${error instanceof Error ? error.message : String(error)}. Check Pi model/provider configuration and try again.`;
    if (last?.role === "assistant" && last.text.startsWith("Pi is analyzing")) last.text = message;
    else item.chat.push({ role: "assistant", text: message });
  }
  if (stillCurrent()) renderAIPanel();
}


// AI 分析统一由用户显式触发：「Analyze last failure」预设项（replay-failure 模式）。
// 停录后零自动 AI：bridge 停录路径不再调用 recording-complete 模式（round5）。
window.startFlowLinkAIAdvice = startAIAdvice;

// 应用级轻提示：普通信息 6 秒后自动消失，警告需手动关闭。
function showFlowlinkNotice(message, kind = "info") {
  let host = document.getElementById("flowlinkNotices");
  if (!host) {
    host = document.createElement("div");
    host.id = "flowlinkNotices";
    document.body.appendChild(host);
  }
  const notice = document.createElement("div");
  notice.className = `flowlink-notice ${kind === "warn" ? "warn" : "info"}`;
  notice.setAttribute("role", kind === "warn" ? "alert" : "status");
  const text = document.createElement("span");
  text.textContent = String(message ?? "");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "flowlink-notice-close";
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "×";
  close.onclick = () => notice.remove();
  notice.append(text, close);
  host.appendChild(notice);
  if (kind !== "warn") setTimeout(() => notice.remove(), 6000);
  return notice;
}
window.showFlowlinkNotice = showFlowlinkNotice;

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
  const state = recordingSession();
  invokeAIMerge("input", message, { attachments: state.aiAttachments });
}

function beginNodeRecording(item, index) {
  // 将捕获内容路由到现有录制项，以重新录制单条指令，而不是新增录制；
  // finishNodeRecording 会应用这些变更。
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
  // 没有捕获到操作时保留原步骤文本；捕获到的操作、元数据和截图槽位
  // 都在同一个节点索引处更新。
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

// 可编辑字段遵循提供的 Steps 参考内容，数据仅保存在当前录制项中。
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
// 展平收敛：原先本文件的 executableFlowSteps 与 bridge.js 的 flatFlowSteps 是
// 两份实现且只有后者标注 flattenedStepId；统一到 renderer/flow-graph.js 的唯一
// 实现（含 stepId 前缀标注），Test 列表、Process 图、playback 事件共用。
function executableFlowSteps(steps) {
  return FlowGraph.flattenFlowSteps(steps).steps;
}

function processStepLabel(step, index, groups = []) {
  const target =
    step.target?.description ||
    step.target?.candidates?.[0]?.value?.name ||
    step.target?.candidates?.[0]?.value ||
    "";
  if (step.label?.trim()) return step.label.trim();
  const kindText = STEP_KIND_TEXT[step.kind] || step.kind;
  if (step.kind === "input" || step.kind === "select")
    return `${kindText} · ${target || "字段"}`;
  if (step.kind === "click" || step.kind === "hover")
    return `${kindText} · ${target || `步骤 ${index + 1}`}`;
  if (step.kind === "navigate") return `${kindText} · ${step.url}`;
  if (step.kind === "openTab") return `${kindText}${step.url ? ` · ${step.url}` : ""}`;
  if (step.kind === "switchTab") return `${kindText} ${step.index + 1}`;
  if (step.kind === "wait") {
    if (step.condition === "timeout") return `${kindText} · ${step.ms ?? 1000} 毫秒`;
    if (step.condition === "userOperation") return `${kindText} · 用户操作`;
    if (step.condition === "networkIdle") return `${kindText} · 网络空闲`;
    return `${kindText} · 元素出现${target ? ` · ${target}` : ""}`;
  }
  if (step.kind === "condition") {
    const flatSteps = executableFlowSteps(groups.flatMap((group) => group.steps || []));
    const name = (id) =>
      flatSteps.find((candidate) => candidate.id === id)?.label?.trim() ||
      id ||
      "顺序继续";
    return `${kindText} · ${step.assertion.kind} · 是 → ${name(step.trueStepId)} · 否 → ${name(step.falseStepId)}`;
  }
  return `${kindText}${target ? ` · ${target}` : ""}`;
}

function ensureProcessGroups(item) {
  if (Array.isArray(item?.processFlow?.steps)) {
    // 收集 condition 步骤（含嵌套 group），给作为其 true/false 目标步骤
    // 所属的组附加 branchEntries，供 Process 视图显示"该组何时被执行"的分支说明。
    const conditionSteps = [];
    const collectConditions = (steps) => {
      for (const step of steps || []) {
        if (step.kind === "group") collectConditions(step.steps);
        else if (step.kind === "condition") conditionSteps.push(step);
      }
    };
    collectConditions(item.processFlow.steps);
    // 步骤 id → 所属顶层组 id（分支目标解析到组，用于组卡徽标）。
    const groupByStepId = new Map();
    for (const group of item.processFlow.steps) {
      if (group?.kind !== "group") continue;
      const walk = (list) => {
        for (const step of list || []) {
          if (step?.kind === "group") walk(step.steps);
          else if (step?.id) groupByStepId.set(step.id, group.id);
        }
      };
      walk(group.steps);
    }
    const branchEntriesOf = (groupId) =>
      conditionSteps
        .filter((step) => {
          const trueGroup = step.trueStepId
            ? groupByStepId.get(step.trueStepId)
            : undefined;
          const falseGroup = step.falseStepId
            ? groupByStepId.get(step.falseStepId)
            : undefined;
          return trueGroup === groupId || falseGroup === groupId;
        })
        .map((step) => ({
          conditionLabel: step.label?.trim() || step.id,
          whenTrue: groupByStepId.get(step.trueStepId) === groupId,
        }));
    let start = 0;
    return item.processFlow.steps
      .filter((step) => step.kind === "group")
      .map((group, index, all) => {
        const flowSteps = group.steps || [];
        const view = {
          id: group.id,
          name: group.label,
          label: group.label,
          index,
          start,
          count: flowSteps.length,
          number: String(index + 1).padStart(2, "0"),
          tab: flowSteps.find((step) => step.page?.index !== undefined)?.page?.index + 1 || 1,
          url: flowSteps.find((step) => step.pageUrl)?.pageUrl || item.url || "",
          flowSteps,
          branchEntries: branchEntriesOf(group.id),
          steps: flowSteps.map((step, stepIndex) =>
            processStepLabel(step, stepIndex, all),
          ),
        };
        start += flowSteps.length;
        return view;
      });
  }
  // 无 processFlow 的录制项（重启后恢复、旧数据）：按标签页/URL 对真实步骤分组，
  // 组名来自实际页面（bridge.js 的 buildGroupsFromSteps），不再套用演示种子文本。
  ensureAssistantData(item);
  if (!item.processGroups) {
    item.processGroups =
      typeof window.buildGroupsFromSteps === "function"
        ? window.buildGroupsFromSteps(item.testFlowSteps || [])
        : [];
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

async function hydrateProcessFlow(item) {
      if (!item || item.processFlowLoaded || item.processFlowLoading) return false;
      if (!item.recordingId || !item.flowFile || !window.flowlink?.flow?.load) return false;
      item.processFlowLoading = true;
      try {
        const flow = await window.flowlink.flow.load(item.flowFile);
        if (!flow?.steps?.length) throw new Error("Saved Flow has no executable steps.");
        let steps = flow.steps;
        if (!steps.every((step) => step.kind === "group")) {
          const groups = ensureProcessGroups(item);
          const total = executableFlowSteps(steps).length;
          const definitions =
            groups.reduce((sum, group) => sum + group.count, 0) === total && groups.length
              ? groups
              : [{ id: "group-recorded", name: "Recorded flow", count: total }];
          let offset = 0;
          steps = definitions.map((group, index) => {
            const count =
              index === definitions.length - 1
                ? steps.length - offset
                : Math.min(group.count, steps.length - offset);
            const value = {
              kind: "group",
              id: group.id || `group-recorded-${index + 1}`,
              label: group.name || `Group ${index + 1}`,
              steps: steps.slice(offset, offset + count),
            };
            offset += count;
            return value;
          });
          if (offset < flow.steps.length) {
            steps[steps.length - 1].steps.push(...flow.steps.slice(offset));
          }
        }
        item.processFlow = { ...flow, steps };
        item.processFlowLoaded = true;
        item.processFlowError = "";
        syncProcessFlowPresentation(item);
        return true;
      } catch (error) {
        item.processFlowError = error instanceof Error ? error.message : String(error);
        console.error("[process] Unable to load saved Flow:", error);
        return false;
      } finally {
        item.processFlowLoading = false;
      }
  }

  function syncProcessFlowPresentation(item) {
      const steps = executableFlowSteps(item.processFlow?.steps || []);
      item.steps = steps.map((step, index) => processStepLabel(step, index));
      item.stepDetails = steps.map((step) => ({
        type: step.kind,
        execution: step.execution === "manual" ? "manual" : "automated",
        target: step.target?.description || "",
        value: step.kind === "input" ? step.value : "",
        url: step.url || "",
        tab: (step.page?.index ?? 0) + 1,
      }));
      item.processGroups = ensureProcessGroups(item);
  }

  async function persistProcessFlow(item, taskCode = currentFlow?.code || activeFlowKey) {
      if (!item?.processFlow || !item.recordingId || !item.flowFile)
        throw new Error("Save this recording before editing its Process flow.");
      const flow = await window.flowlink.flow.updateSteps({
        taskCode,
        recordingId: item.recordingId,
        steps: item.processFlow.steps,
      });
      item.processFlow = { ...item.processFlow, version: flow.version, steps: flow.steps };
      item.processFlowError = "";
      item.nodeUpdates = true;
      item.referenceVariablesLoaded = false;
      syncProcessFlowPresentation(item);
      rebuildItemTestFlow(item);
  }

/* ============================================================
 * REFINED 单线演进：pending 暂存与 AI 面板 Confirm / Discard 决议
 *
 * AI 针对已有 REFINED 记录的修改（面板 Refine）暂存为
 * artifacts/<flowId>/pending.json（主进程 flow:stagePending，单槽覆盖）。
 * 生成消息附中文变更清单（复用 diff 函数计算）；AI 面板快捷条出现
 * Confirm / Discard。Confirm（主进程校验 baseVersion → 历史快照 →
 * version+1 覆盖）或 Discard。文件是唯一事实源；重启后仍显示。
 * ============================================================ */

/** pending 检测：一次性加载未决议 pending（文件是事实源）。
 * 读失败按无 pending 处理并标记已加载，避免每次渲染死循环重试；
 * ai:pending 事件与生成方会重置 pendingLoaded 触发重查。 */
async function hydratePendingUpdate(item) {
  if (!item?.recordingId || !item.flowFile) return false;
  if (!window.flowlink?.flow?.loadPending) return false;
  const taskCode = currentFlow?.code || activeFlowKey;
  item.pendingLoading = true;
  try {
    const pending = await window.flowlink.flow.loadPending({
      taskCode,
      recordingId: item.recordingId,
    });
    item.pendingUpdate = pending && pending.flow ? pending : null;
    return true;
  } catch (error) {
    console.error("[ai] 待确认更新读取失败：", error);
    item.pendingUpdate = null;
    return true;
  } finally {
    item.pendingLoaded = true;
    item.pendingLoading = false;
  }
}

/** 提案差异比较字段：label/expect/settle/isOptional/timeout/execution 与
 * 各类值字段（value/key/url/assertion/…）。刻意不含 target 候选证据——
 * 再水化/重锚定会微调候选顺序，属于生成管线噪声，不视为业务修改。 */
const PROPOSAL_DIFF_FIELDS = [
  "kind", "label", "execution", "isOptional", "timeout", "settle", "expect",
  "value", "key", "url", "assertion", "trueStepId", "falseStepId",
  "into", "prop", "attr", "ms", "condition", "files", "action", "promptText",
  "code", "index", "button", "clickCount", "modifiers", "position", "clear",
  "to", "delta",
];

function proposalStepSignature(step) {
  const picked = {};
  for (const field of PROPOSAL_DIFF_FIELDS) {
    if (step && field in step) picked[field] = step[field];
  }
  return JSON.stringify(picked);
}

/** 提案差异：以扁平 stepId + 顶层组 id 对齐。返回
 * {added, removed, changed, groupAdded, groupRemoved, groupChanged}（均为 Set）。 */
function computeProposalDiff(currentFlow, proposalFlow) {
  const currentFlat = FlowGraph.flattenFlowSteps(currentFlow?.steps || []);
  const proposalFlat = FlowGraph.flattenFlowSteps(proposalFlow?.steps || []);
  const stepsById = (flat) =>
    new Map(flat.entries.map((entry) => [entry.flattenedStepId, entry.step]));
  const currentSteps = stepsById(currentFlat);
  const proposalSteps = stepsById(proposalFlat);
  const added = new Set();
  const removed = new Set();
  const changed = new Set();
  for (const [id, step] of proposalSteps) {
    const before = currentSteps.get(id);
    if (!before) added.add(id);
    else if (proposalStepSignature(step) !== proposalStepSignature(before))
      changed.add(id);
  }
  for (const id of currentSteps.keys()) if (!proposalSteps.has(id)) removed.add(id);
  const groupsOf = (flow) =>
    new Map(
      (flow?.steps || [])
        .filter((step) => step.kind === "group")
        .map((group) => [group.id, group]),
    );
  const currentGroups = groupsOf(currentFlow);
  const proposalGroups = groupsOf(proposalFlow);
  const groupAdded = new Set();
  const groupRemoved = new Set();
  const groupChanged = new Set();
  for (const [id, group] of proposalGroups) {
    const before = currentGroups.get(id);
    if (!before) {
      groupAdded.add(id);
      continue;
    }
    if ((group.label || "") !== (before.label || "")) groupChanged.add(id);
  }
  for (const id of currentGroups.keys())
    if (!proposalGroups.has(id)) groupRemoved.add(id);
  // 组内任一步骤差异（或组被增删）→ 该组卡描黄（同 id 内容有变化）。
  const markGroupChangedByStep = (flat, idSet) => {
    for (const entry of flat.entries) {
      const gid = entry.groupId;
      if (!gid || groupAdded.has(gid) || groupRemoved.has(gid) || groupChanged.has(gid))
        continue;
      if (idSet.has(entry.flattenedStepId)) groupChanged.add(gid);
    }
  };
  markGroupChangedByStep(currentFlat, new Set([...removed, ...changed]));
  markGroupChangedByStep(proposalFlat, new Set([...added, ...changed]));
  return { added, removed, changed, groupAdded, groupRemoved, groupChanged };
}

function pendingSourceText(source) {
  return source === "takeover-repair" ? "AI 接管后自动修复" : "AI 面板 Refine";
}

/** pending 变更清单文本：相对正式版本的分组增删改名、步骤增删改（带步骤名），
 * 网关/分支变化（condition 步骤的增删改）单列。复用 computeProposalDiff 对齐。 */
function describePendingChanges(currentFlow, pendingFlow) {
  const diff = computeProposalDiff(currentFlow, pendingFlow);
  const flatStepsOf = (flow) =>
    new Map(
      FlowGraph.flattenFlowSteps(flow?.steps || []).entries.map((entry) => [
        entry.flattenedStepId,
        entry.step,
      ]),
    );
  const currentSteps = flatStepsOf(currentFlow);
  const pendingSteps = flatStepsOf(pendingFlow);
  const nameOf = (step, fallback) =>
    String(step?.label || step?.kind || fallback || "").trim() || fallback || "";
  const groupsOf = (flow) =>
    new Map(
      (flow?.steps || [])
        .filter((step) => step.kind === "group")
        .map((group) => [group.id, group]),
    );
  const currentGroups = groupsOf(currentFlow);
  const pendingGroups = groupsOf(pendingFlow);

  const lines = [];
  if (diff.groupAdded.size)
    lines.push(
      "新增分组：" +
        [...diff.groupAdded].map((id) => nameOf(pendingGroups.get(id), id)).join("、"),
    );
  if (diff.groupRemoved.size)
    lines.push(
      "删除分组：" +
        [...diff.groupRemoved].map((id) => nameOf(currentGroups.get(id), id)).join("、"),
    );
  const renamed = [...diff.groupChanged]
    .map((id) => {
      const before = currentGroups.get(id);
      const after = pendingGroups.get(id);
      if (!before || !after || (before.label || "") === (after.label || "")) return null;
      return `${nameOf(before, id)} → ${nameOf(after, id)}`;
    })
    .filter(Boolean);
  if (renamed.length) lines.push("分组改名：" + renamed.join("、"));

  const listNames = (ids, from) =>
    [...ids]
      .filter((id) => from.get(id)?.kind !== "condition")
      .map((id) => nameOf(from.get(id), id))
      .filter(Boolean)
      .join("、");
  if (diff.added.size) {
    const text = listNames(diff.added, pendingSteps);
    if (text) lines.push("新增步骤：" + text);
  }
  if (diff.removed.size) {
    const text = listNames(diff.removed, currentSteps);
    if (text) lines.push("删除步骤：" + text);
  }
  if (diff.changed.size) {
    const text = listNames(diff.changed, pendingSteps);
    if (text) lines.push("修改步骤：" + text);
  }
  const conditionChanges = [];
  for (const id of diff.added)
    if (pendingSteps.get(id)?.kind === "condition")
      conditionChanges.push(`新增「${nameOf(pendingSteps.get(id), id)}」`);
  for (const id of diff.removed)
    if (currentSteps.get(id)?.kind === "condition")
      conditionChanges.push(`移除「${nameOf(currentSteps.get(id), id)}」`);
  for (const id of diff.changed)
    if (pendingSteps.get(id)?.kind === "condition")
      conditionChanges.push(`调整「${nameOf(pendingSteps.get(id), id)}」`);
  if (conditionChanges.length)
    lines.push("网关/分支变化：" + conditionChanges.join("；"));
  return lines.join("\n");
}

/** Confirm：主进程校验 baseVersion → 存历史快照 → version+1 覆盖正式 Flow →
 * 清 pending 与标记。成功后重载 processFlow（Test/Process/Instruction 随之刷新）。 */
async function confirmPendingUpdate(item) {
  if (!item?.recordingId || item.pendingResolving) return;
  const taskCode = currentFlow?.code || activeFlowKey;
  item.pendingResolving = true;
  renderAIPanel();
  try {
    const flow = await window.flowlink.flow.confirmPending({
      taskCode,
      recordingId: item.recordingId,
    });
    item.pendingUpdate = null;
    item.pendingLoaded = true;
    item.lastTakeover = null;
    item.selectedGroup = null;
    item.processFlow = null;
    item.processFlowLoaded = false;
    item.processFlowError = "";
    await hydrateProcessFlow(item);
    rebuildItemTestFlow(item);
    showFlowlinkNotice(`已确认，流程更新为 v${flow?.version ?? ""}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showFlowlinkNotice(`确认失败：${message}`, "warn");
    appendAIMessage(
      item,
      "assistant",
      `待确认版本未能确认：${message}\n\n若因生成后有新的修改生效，请重新发起一次生成（新的待确认版本会基于最新流程）。`,
    );
  } finally {
    item.pendingResolving = false;
    renderSummaryWorkspace();
  }
}

/** Discard：删 pending 文件与标记，流程保持当前版本。 */
async function discardPendingUpdate(item) {
  if (!item?.recordingId || item.pendingResolving) return;
  const taskCode = currentFlow?.code || activeFlowKey;
  item.pendingResolving = true;
  renderAIPanel();
  try {
    await window.flowlink.flow.discardPending({
      taskCode,
      recordingId: item.recordingId,
    });
    item.pendingUpdate = null;
    item.pendingLoaded = true;
    showFlowlinkNotice("已丢弃待确认更新，流程保持当前版本");
  } catch (error) {
    showFlowlinkNotice(
      `丢弃失败：${error instanceof Error ? error.message : String(error)}`,
      "warn",
    );
  } finally {
    item.pendingResolving = false;
    renderSummaryWorkspace();
  }
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

async function rebuildItemTestFlow(item) {
  if (!item) return;
  if (item.processFlow?.steps) {
    item.testFlowSteps = executableFlowSteps(item.processFlow.steps);
    item.testResults = item.testFlowSteps.map(() => ({ status: "pending" }));
    return;
  }
  // 界面草稿尚未发生变化时，优先使用已持久化的 Flow 文件。
  if (item.flowFile && !item.nodeUpdates) {
    try {
      const flow = await window.flowlink.flow.load(item.flowFile);
      if (flow) {
        item.testFlowSteps = (flow.steps || []).map((step) => step);
        item.testResults = item.testFlowSteps.map(() => ({
          status: "pending",
        }));
        return;
      }
    } catch {}
  }
  // 不再从界面草稿伪重建测试流：该路径把「目标」降级为单一 text 候选，
  // 破坏录制证据链（docs/archive/plan-instruction-revamp.md §2）。演示/草稿条目
  // 的 Test 列表退回本地文本行展示。
  item.testFlowSteps = [];
  item.testResults = [];
}

function bindStepEditor() {
  // Instruction 的唯一编辑管道：输入 → 更新 processFlow.steps 内的步骤对象
  // → 防抖 500ms 经 persistProcessFlow(flow:updateSteps) 落盘；失败回滚并内联报错。
  const panel = $("summaryResultPanel");
  if (!panel) return;
  panel.oninput = (e) => {
    const input = e.target.closest("[data-step-field]");
    if (input) applyInstructionFieldEdit(input);
  };
  panel.onchange = (e) => {
    const input = e.target.closest("[data-step-field]");
    if (!input) return;
    applyInstructionFieldEdit(input);
    const field = input.dataset.stepField;
    const row = input.closest(".instruction-step");
    const item = currentAssistantItem();
    if (!row || !item) return;
    if (field === "assertionKind") {
      // 只切换可见性，不整格重渲染：value/count 缺期望值时保持用户的选择，
      // 等期望值补齐后 rebuildStepAssertion 才写入 step.assertion。
      const kind = input.value;
      const equalsLabel = row
        .querySelector('[data-step-field="assertionEquals"]')
        ?.closest("label");
      if (equalsLabel)
        equalsLabel.hidden = !["text", "value", "count"].includes(kind);
      const containsLabel = row
        .querySelector('[data-step-field="assertionContains"]')
        ?.closest("label");
      if (containsLabel) containsLabel.hidden = kind !== "text";
      if (
        (kind === "value" || kind === "count") &&
        !String(instructionInputValue(row, "assertionEquals") ?? "").trim()
      )
        showInstructionRowError(row, "该断言需要填写期望值后才能保存。");
      return;
    }
    if (
      ["waitCondition", "prop", "expectKind", "execution", "targetRef"].includes(
        field,
      )
    ) {
      const fields = row.querySelector(".step-detail-fields");
      if (fields?.dataset.built) {
        const found = instructionStepEntry(item, row.dataset.stepIndex);
        if (found)
          renderInstructionDrawer(fields, item, found.entry, found.flat);
      }
    }
  };
  if (!panel.dataset.instructionExpandBound) {
    panel.addEventListener("click", (e) => {
      const menuButton = e.target.closest(".instruction-step-menu");
      if (menuButton) {
        openInstructionStepMenu(menuButton);
        return;
      }
      const rerecord = e.target.closest("[data-instruction-rerecord]");
      if (rerecord) {
        const item = currentAssistantItem();
        const groupId = rerecord.dataset.instructionRerecord;
        if (item && groupId) {
          void flushInstructionEdits(item); // 重录按磁盘 Flow 回放前缀，先落盘编辑
          void beginGroupRecording(item, groupId, "replace");
        }
        return;
      }
      const item = currentAssistantItem();
      const textEl = e.target.closest(".step-row-text");
      if (textEl && item) {
        const row = textEl.closest(".instruction-step");
        const found = row
          ? instructionStepEntry(item, row.dataset.stepIndex)
          : null;
        if (found && instructionEditable(item))
          beginInlineLabelEdit(row, item, found.entry);
        return;
      }
      const button = e.target.closest("[data-instruction-expand]");
      if (!button || !item) return;
      const id = button.dataset.instructionExpand,
        expanded = button.getAttribute("aria-expanded") !== "true";
      item.instructionExpanded ??= [];
      item.instructionExpanded = item.instructionExpanded.filter(
        (value) => value !== id,
      );
      if (expanded) item.instructionExpanded.push(id);
      button.setAttribute("aria-expanded", String(expanded));
      button.querySelector("span").textContent = expanded
        ? "Collapse"
        : "Expand";
      button
        .closest(".steps-group")
        .querySelectorAll(".instruction-step")
        .forEach((row) => {
          const fields = row.querySelector("[data-group-details]");
          fields.hidden = !expanded;
          if (expanded && !fields.dataset.built) {
            const found = instructionStepEntry(item, row.dataset.stepIndex);
            if (found)
              renderInstructionDrawer(fields, item, found.entry, found.flat);
          }
        });
    });
    panel.dataset.instructionExpandBound = "true";
  }
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
  // 同意状态按活动 Flow 隔离，并缓存在当前渲染器会话中；
  // 只有首次读取该 Flow 的偏好草稿时才访问 localStorage。
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

// Reference 文件归当前查看的录制项所有；上传文件仅保留在本浏览器会话中。
let referenceSequence = 0;
function ensureReferenceFiles(item) {
  // 每个录制项只生成一次 Reference。其对象 URL 在本浏览器会话中持续有效，
  // 上传的文件也仅保存在本地。
  if (!item) return [];
  if (!item.references) {
    const steps = item.steps || [];
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
      kind: "file",
      url: URL.createObjectURL(file.file),
    }));
  }
  return item.references;
}

async function hydrateReferenceVariables(item) {
  if (!item || item.referenceVariablesLoaded || item.referenceVariablesLoading) return false;
  if (!item.recordingId || !item.flowFile || !window.flowlink?.flow?.load) {
    item.referenceVariablesLoaded = true;
    return false;
  }
  item.referenceVariablesLoading = true;
  try {
    const flow = await window.flowlink.flow.load(item.flowFile);
    const knownNames = new Set(
      ensureReferenceFiles(item)
        .filter((reference) => reference.kind === "variable")
        .map((reference) => reference.name),
    );
    for (const variable of flow.variables || []) {
      if (knownNames.has(variable.name)) continue;
      item.references.push({
        id: "reference-" + ++referenceSequence,
        kind: "variable",
        name: variable.name,
        type: "Variable",
        variableType: variable.type || "string",
        secret: !!variable.secret,
        source: variable.source || "input",
        value: variable.defaultValue || "",
      });
    }
    item.referenceLoadError = "";
    item.referenceVariablesLoaded = true;
    return true;
  } catch (error) {
    item.referenceLoadError = error instanceof Error ? error.message : String(error);
    console.error("[reference] Unable to load flow variables:", error);
    return false;
  } finally {
    item.referenceVariablesLoading = false;
  }
}

function referenceVariableDefinitions(references) {
  return references
    .filter((reference) => reference.kind === "variable")
    .map((reference) => ({
      name: reference.name,
      type: reference.variableType || "string",
      ...(!reference.secret ? { defaultValue: reference.value ?? "" } : {}),
      secret: !!reference.secret,
      source: reference.source || "input",
    }));
}

async function referenceVariablesForReplay(item) {
  await hydrateReferenceVariables(item);
  if (item.referenceLoadError)
    throw new Error(`Unable to load Reference variables: ${item.referenceLoadError}`);
  return Object.fromEntries(
    ensureReferenceFiles(item)
      .filter((reference) => reference.kind === "variable")
      .map((reference) => [reference.name, reference.value ?? ""]),
  );
}

window.referenceVariablesForReplay = referenceVariablesForReplay;

async function persistReferenceVariables(item, references) {
  if (!item.recordingId || !item.flowFile || !window.flowlink?.flow?.updateVariables)
    return;
  await window.flowlink.flow.updateVariables({
    taskCode: currentFlow?.code || activeFlowKey,
    recordingId: item.recordingId,
    variables: referenceVariableDefinitions(references),
  });
}

function bindReferenceFiles() {
  const input = $("referenceFileInput"),
    panel = $("summaryResultPanel"),
    item = currentAssistantItem();
  if (!input || !item) return;
  const redraw = () => {
    fillReferencePanel(panel, item);
    bindReferenceFiles();
  };
  const variablesLoaded = hydrateReferenceVariables(item);
  if (item.referenceVariablesLoading)
    panel.querySelector("#referenceAdd").disabled = true;
  void variablesLoaded.then((loaded) => {
    if (
      loaded &&
      panel.isConnected &&
      currentAssistantItem() === item &&
      item.resultTab === "Reference"
    )
      redraw();
    else {
      const status = panel.querySelector("#referenceStatus");
      if (status && item.referenceLoadError) status.textContent = item.referenceLoadError;
      const addVariable = panel.querySelector("[data-reference-add-variable]");
      if (addVariable && item.referenceLoadError) addVariable.disabled = true;
    }
  });
  const all = panel.querySelector("#referenceSelectAll");
  const syncChecks = () => {
    const files = ensureReferenceFiles(item),
      count = files.filter((file) => file.selected).length;
    all.checked = files.length > 0 && count === files.length;
    all.indeterminate = count > 0 && count < files.length;
    $("referenceDownload").disabled = count === 0;
    panel
      .querySelectorAll("[data-reference-check]")
      .forEach(
        (check) =>
          (check.checked = !!files.find(
            (file) => file.id === check.dataset.referenceCheck,
          )?.selected),
      );
  };
  syncChecks();
  $("referenceDownload").onclick = () => {
    downloadReferenceArchive(item);
  };
  const dialog = panel.querySelector("#referenceDialog");
  const showChooser = () => {
    dialog.innerHTML = `<h2 id="referenceDialogTitle">Add to Reference</h2><p>Choose what to add.</p><div class="reference-dialog-actions"><button type="button" class="btn secondary reference-dialog-btn" data-reference-add-variable ${item.referenceLoadError ? "disabled" : ""}>${designIcon("plus")}<span>Add variable</span></button><button type="button" class="btn secondary reference-dialog-btn" data-reference-upload>${designIcon("plus")}<span>Upload files</span></button><button type="button" class="btn secondary" data-reference-dialog-close>Cancel</button></div>`;
    dialog.showModal();
  };
  $("referenceAdd").onclick = showChooser;
  input.onchange = () => {
    // 文件选择完成（选择器已关闭）后恢复抽屉 Escape 响应。
    setTimeout(() => (suppressDrawerCancelUntil = 0), 1000);
    for (const file of input.files) {
      const ext = file.name.split(".").pop().toLowerCase(),
        type = ["xlsx", "xls", "csv"].includes(ext)
          ? "Excel"
          : ["md", "markdown"].includes(ext)
            ? "MD"
            : ext.toUpperCase();
      item.references.push({
        id: "reference-" + ++referenceSequence,
        kind: "file",
        name: file.name,
        type,
        file,
        url: URL.createObjectURL(file),
      });
    }
    redraw();
    $("referenceAdd").focus();
  };
  panel.onclick = async (e) => {
    const addVariable = e.target.closest("[data-reference-add-variable]"),
      upload = e.target.closest("[data-reference-upload]"),
      closeDialog = e.target.closest("[data-reference-dialog-close]"),
      edit = e.target.closest("[data-reference-edit]"),
      remove = e.target.closest("[data-reference-delete]");
    if (addVariable) {
      showReferenceEditor(dialog, null);
      return;
    }
    if (upload) {
      dialog.close();
      input.oncancel = (e) => {
        e.stopPropagation();
        setTimeout(() => (suppressDrawerCancelUntil = 0), 1000);
      };
      suppressDrawerCancelUntil = Date.now() + 60000;
      input.click();
      return;
    }
    if (closeDialog) {
      dialog.close();
      return;
    }
    if (edit) {
      showReferenceEditor(
        dialog,
        item.references.find((reference) => reference.id === edit.dataset.referenceEdit),
      );
      return;
    }
    if (remove) {
      const index = item.references.findIndex(
        (file) => file.id === remove.dataset.referenceDelete,
      );
      if (index < 0) return;
      if (
        !(await confirmWorkspaceAction(
          `Delete “${item.references[index].name}” from Reference?`,
        ))
      )
        return;
      const nextReferences = item.references.filter((_, row) => row !== index);
      if (item.references[index].kind === "variable") {
        try {
          await persistReferenceVariables(item, nextReferences);
        } catch (error) {
          console.error("[reference] Unable to delete variable:", error);
          const status = panel.querySelector("#referenceStatus");
          if (status) status.textContent = `Unable to save variable changes: ${error.message || error}`;
          return;
        }
      }
      item.references.splice(index, 1);
      redraw();
      const next = panel.querySelector("[data-reference-delete]");
      (next || $("referenceAdd")).focus();
    }
  };
  panel.onchange = (e) => {
    if (e.target.matches("#referenceSelectAll")) {
      item.references.forEach((file) => (file.selected = e.target.checked));
      syncChecks();
    } else if (e.target.matches("[data-reference-check]")) {
      const file = item.references.find(
        (reference) => reference.id === e.target.dataset.referenceCheck,
      );
      if (file) file.selected = e.target.checked;
      syncChecks();
    } else if (e.target.matches("[name=referenceType]")) {
      const value = dialog.querySelector("[name=referenceValue]");
      if (value) value.type = e.target.value === "secret" ? "password" : "text";
    }
  };
  dialog.onsubmit = async (event) => {
    event.preventDefault();
    const form = event.target,
      editingId = form.dataset.referenceId,
      existing = item.references.find((reference) => reference.id === editingId),
      isVariable = !existing || existing.kind === "variable",
      rawName = form.elements.referenceName.value.trim(),
      name = isVariable ? rawName : rawName.replace(/[\\/:*?"<>|]/g, "_"),
      value = isVariable ? form.elements.referenceValue.value : undefined,
      variableType = existing?.variableType || form.elements.referenceType?.value || "string",
      secret = existing?.secret ?? variableType === "secret";
    if (!name) return;
    if (isVariable && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      form.elements.referenceName.setCustomValidity("Use a valid variable identifier.");
      form.elements.referenceName.reportValidity();
      return;
    }
    if (
      isVariable &&
      item.references.some(
        (reference) =>
          reference.kind === "variable" &&
          reference.id !== editingId &&
          reference.name === name,
      )
    ) {
      form.elements.referenceName.setCustomValidity("A variable with this name already exists.");
      form.elements.referenceName.reportValidity();
      return;
    }
    form.elements.referenceName.setCustomValidity("");
    const updated = existing
      ? { ...existing, name, ...(isVariable ? { value, variableType, secret } : {}) }
      : {
          id: "reference-" + ++referenceSequence,
          kind: "variable",
          name,
          type: "Variable",
          variableType,
          secret,
          source: "input",
          value,
        };
    const nextReferences = existing
      ? item.references.map((reference) => reference.id === editingId ? updated : reference)
      : [...item.references, updated];
    if (isVariable) {
      try {
        await persistReferenceVariables(item, nextReferences);
      } catch (error) {
        console.error("[reference] Unable to save variable:", error);
        const status = panel.querySelector("#referenceStatus");
        if (status) status.textContent = `Unable to save variable changes: ${error.message || error}`;
        return;
      }
    }
    if (existing) {
      const position = item.references.findIndex((reference) => reference.id === editingId);
      item.references[position] = updated;
    } else {
      item.references.push(updated);
    }
    dialog.close();
    redraw();
    $("referenceAdd").focus();
  };
}

function showReferenceEditor(dialog, reference) {
  const isVariable = !reference || reference.kind === "variable",
    title = reference ? "Update Reference item" : "Add variable",
    variableType = reference?.variableType || "string",
    types = ["string", "text", "email", "date", "number", "secret", "file"];
  dialog.innerHTML = `<form class="reference-editor" data-reference-id="${escapeHTML(reference?.id || "")}"><h2 id="referenceDialogTitle">${title}</h2><label>Name<input name="referenceName" value="${escapeHTML(reference?.name || "")}" maxlength="255" required ${isVariable ? 'pattern="[A-Za-z_][A-Za-z0-9_]*"' : ""}></label>${isVariable ? `${reference ? "" : `<label>Type<select name="referenceType">${types.map((type) => `<option value="${type}" ${type === variableType ? "selected" : ""}>${type}</option>`).join("")}</select></label>`}<label>Value<input name="referenceValue" type="${reference?.secret || variableType === "secret" ? "password" : "text"}" value="${escapeHTML(reference?.value || "")}"></label>` : ""}<div class="reference-dialog-actions"><button type="submit" class="btn">Save</button><button type="button" class="btn secondary" data-reference-dialog-close>Cancel</button></div></form>`;
  dialog.showModal();
  dialog.querySelector("[name=referenceName]").focus();
}

function bindScreenshotZoom() {
  const panel = $("summaryResultPanel");
  if (!panel || panel.dataset.screenshotZoomBound) return;
  panel.addEventListener("click", (e) => {
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
  });
  panel.dataset.screenshotZoomBound = "true";
}

function nextFlowVariableName(flow, prefix) {
  const names = new Set((flow.variables || []).map((variable) => variable.name));
  let index = 1;
  while (names.has(`${prefix}_${index}`)) index++;
  return `${prefix}_${index}`;
}

// 分组命名 / 通用提示统一走模板化 <dialog>：原生 prompt/alert 与新 UI 不一致，
// 且无法做内联校验。showModal 自带焦点圈定；Enter 提交、Esc 走 cancel。
function showProcessGroupDialog({ title = "Group name", name = "" } = {}) {
  return new Promise((resolve) => {
    const dialog = rowTemplate("processGroupDialogTemplate").cloneNode(true);
    const form = dialog.querySelector("form");
    dialog.querySelector("[data-group-dialog-title]").textContent = title;
    const input = form.elements.groupName;
    input.value = name;
    const error = dialog.querySelector(".process-step-error");
    const finish = (value) => {
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    dialog.oncancel = (event) => {
      event.preventDefault();
      finish(null);
    };
    dialog.querySelector("[data-group-dialog-cancel]").onclick = () =>
      finish(null);
    form.onsubmit = (event) => {
      event.preventDefault();
      const label = input.value.trim();
      if (!label) {
        error.hidden = false;
        error.textContent = "Group name cannot be empty.";
        return;
      }
      finish(label);
    };
    document.body.appendChild(dialog);
    dialog.showModal();
    input.focus();
    input.select();
  });
}

function showWorkspaceNotice(message) {
  return new Promise((resolve) => {
    const dialog = rowTemplate("noticeDialogTemplate").cloneNode(true);
    dialog.querySelector("[data-notice-message]").textContent = message;
    const ok = dialog.querySelector("[data-notice-ok]");
    const finish = () => {
      dialog.close();
      dialog.remove();
      resolve();
    };
    dialog.oncancel = (event) => {
      event.preventDefault();
      finish();
    };
    ok.onclick = finish;
    document.body.appendChild(dialog);
    dialog.showModal();
    ok.focus();
  });
}

// 危险操作确认（替代 window.confirm）：模板化 <dialog>，Esc/cancel 均视为拒绝。
function showConfirmDialog(message, { confirmLabel = "OK" } = {}) {
  return new Promise((resolve) => {
    const dialog = rowTemplate("confirmDialogTemplate").cloneNode(true);
    dialog.querySelector("[data-confirm-message]").textContent = message;
    const confirm = dialog.querySelector("[data-confirm-ok]");
    confirm.textContent = confirmLabel;
    const finish = (value) => {
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    dialog.oncancel = (event) => {
      event.preventDefault();
      finish(false);
    };
    confirm.onclick = () => finish(true);
    dialog.querySelector("[data-confirm-cancel]").onclick = () =>
      finish(false);
    document.body.appendChild(dialog);
    dialog.showModal();
    confirm.focus();
  });
}
window.showConfirmDialog = showConfirmDialog;

async function addProcessGroupAfter(item, groupId) {
  const groups = item.processFlow?.steps || [];
  const index = groups.findIndex((group) => group.kind === "group" && group.id === groupId);
  if (index < 0) return;
  const label = await showProcessGroupDialog({
    title: "New group",
    name: `Group ${groups.length + 1}`,
  });
  if (!label) return;
  const group = {
    kind: "group",
    id: `group_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    label,
    steps: [],
  };
  groups.splice(index + 1, 0, group);
  item.selectedGroup = group.id;
  try {
    await persistProcessFlow(item);
    renderSummaryWorkspace();
  } catch (error) {
    item.processFlowError = error instanceof Error ? error.message : String(error);
    renderSummaryWorkspace();
  }
}

function showManualStepEditor(item, groupId, insertAtIndex) {
  const group = item.processFlow?.steps.find(
    (step) => step.kind === "group" && step.id === groupId,
  );
  if (!group) return;
  // 契约已放宽：condition 可位于组内任意位置，无需钳位/拒绝插入。
  const dialog = rowTemplate("processStepEditorTemplate").cloneNode(true);
  dialog.querySelector("[data-step-editor-title]").textContent =
    insertAtIndex === undefined
      ? `Add step to ${group.label}`
      : `Insert step into ${group.label}`;
  const form = dialog.querySelector("form");
  const groups = item.processFlow.steps.filter((step) => step.kind === "group");
  // 分支目标 = 同 Flow 内任意已存在步骤（缺省 = 顺序继续）。
  const stepOptions = executableFlowSteps(item.processFlow.steps)
    .map(
      (step) =>
        `<option value="${escapeHTML(step.id)}">${escapeHTML(
          (step.label?.trim() || step.id) + "（" + step.kind + "）",
        )}</option>`,
    )
    .join("");
  const targetReferences = executableFlowSteps(item.processFlow.steps)
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.target)
    .map(({ step, index }) => ({
      index,
      label: `${step.kind} · ${step.target.description || step.id}`,
    }));
  const hasElementRefs = targetReferences.length > 0;
  // 上下文限定：元素类步骤只有在该 Flow 已有可复用的 ElementRef 时才提供；
  // script 步骤刻意不出现在 UI（回放安全边界，见架构文档编辑器范围）。
  const kinds = [
    "navigate", "key", "scroll", "wait", "openTab", "switchTab",
    "closeTab", "dialog",
    ...(hasElementRefs
      ? ["click", "input", "select", "hover", "upload", "extract", "assert", "condition"]
      : []),
  ];
  form.elements.kind.innerHTML = kinds
    .map((kind) => `<option value="${kind}">${kind}</option>`)
    .join("");
  form.elements.targetRef.insertAdjacentHTML(
    "beforeend",
    targetReferences
      .map((target) => `<option value="${target.index}">${escapeHTML(target.label)}</option>`)
      .join(""),
  );
  form.elements.trueStepId.insertAdjacentHTML("beforeend", stepOptions);
  form.elements.falseStepId.insertAdjacentHTML("beforeend", stepOptions);
  if (!hasElementRefs)
    form.elements.waitCondition.querySelector('option[value="element"]')?.remove();

  document.body.appendChild(dialog);
  dialog.showModal();

  const errorLabel = dialog.querySelector(".process-step-error");
  const showError = (message) => {
    errorLabel.hidden = false;
    errorLabel.textContent = message;
  };
  const secretField = form.elements.secret;
  form.elements.targetRef.onchange = () => {
    const choice = form.elements.targetRef.value;
    const selected = choice ? targetReferences[Number(choice)]?.step.target : undefined;
    const isPassword = selected?.observed?.attributes?.type?.toLowerCase() === "password";
    if (isPassword) secretField.checked = true;
    secretField.disabled = isPassword;
  };
  // 只显示当前 kind 真正用到的字段：全部铺开会让 17 种步骤共享一张巨型表单。
  const fieldsByKind = {
    navigate: ["url"],
    openTab: ["url"],
    key: ["key", "targetRef"],
    scroll: ["deltaY", "targetRef"],
    wait: ["waitCondition", "ms", "prompt", "targetRef"],
    switchTab: ["tabIndex"],
    closeTab: ["tabIndex"],
    dialog: ["dialogAction"],
    click: ["targetRef"],
    hover: ["targetRef"],
    upload: ["targetRef"],
    extract: ["targetRef", "extra"],
    input: ["targetRef", "value", "secret", "variableName"],
    select: ["targetRef", "value"],
    assert: ["targetRef", "assertionKind", "expected"],
    condition: ["targetRef", "assertionKind", "expected", "trueStepId", "falseStepId"],
  };
  const updateFields = () => {
    const kind = form.elements.kind.value;
    const visible = new Set(["kind", "label", "execution", ...(fieldsByKind[kind] || [])]);
    // wait/assert/condition 有各自的执行语义，manual 标记对它们无意义。
    if (["wait", "assert", "condition"].includes(kind)) visible.delete("execution");
    if (kind === "wait") {
      const condition = form.elements.waitCondition.value;
      if (condition !== "timeout") visible.delete("ms");
      if (condition !== "userOperation") visible.delete("prompt");
      if (condition !== "element") visible.delete("targetRef");
    }
    if (kind === "assert" || kind === "condition") {
      if (!["text", "value", "count"].includes(form.elements.assertionKind.value))
        visible.delete("expected");
    }
    dialog.querySelectorAll("[data-field]").forEach((row) => {
      row.hidden = !visible.has(row.dataset.field);
    });
  };
  form.elements.kind.onchange = updateFields;
  form.elements.waitCondition.onchange = updateFields;
  form.elements.assertionKind.onchange = updateFields;
  updateFields();
  const close = () => {
    dialog.close();
    dialog.remove();
  };
  dialog.oncancel = (event) => {
    event.preventDefault();
    close();
  };
  dialog.querySelector("[data-step-cancel]").onclick = close;
  form.onsubmit = async (event) => {
    event.preventDefault();
    // Instruction 抽屉可能有防抖中的编辑：先落盘，避免本表单的失败回滚波及它们。
    await flushInstructionEdits(item);
    const values = form.elements;
    const kind = values.kind.value;
    const page = group.steps.at(-1)?.page;
    const manualExecution =
      values.execution.value === "manual" &&
      !["wait", "assert", "condition"].includes(kind);
    const step = {
      id: `manual_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      ...(values.label.value.trim() ? { label: values.label.value.trim() } : {}),
      ...(manualExecution ? { execution: "manual" } : {}),
      ...(page ? { page: structuredClone(page) } : {}),
      kind,
    };
    const targetChoice = values.targetRef.value;
    const selectedTarget = targetChoice
      ? targetReferences[Number(targetChoice)]?.step.target
      : undefined;
    const target = selectedTarget ? structuredClone(selectedTarget) : undefined;
    const secretInput =
      values.secret.checked ||
      target?.observed?.attributes?.type?.toLowerCase() === "password";
    const requiredTarget = ["click", "input", "select", "hover", "upload", "extract", "assert", "condition"].includes(kind) ||
      (kind === "wait" && values.waitCondition.value === "element");
    if (requiredTarget && !target) {
      showError("Select an element observed in a recorded step.");
      return;
    }
    if (target) step.target = target;
    if (kind === "navigate" || kind === "openTab") {
      const url = values.url.value.trim();
      if (kind === "navigate" && !url) {
        showError("A URL is required for navigation.");
        return;
      }
      if (url) step.url = url;
    }
    if (kind === "input" || kind === "select") {
      if (!values.value.value && kind === "input") {
        showError("Enter the value to parameterize.");
        return;
      }
      if (kind === "input") {
        const name = values.variableName.value.trim() || nextFlowVariableName(item.processFlow, "input");
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
            (item.processFlow.variables || []).some((variable) => variable.name === name)) {
          showError("Use an unused variable identifier.");
          return;
        }
        const secret = secretInput;
        item.processFlow.variables ||= [];
        item.processFlow.variables.push({
          name,
          type: secret ? "secret" : "string",
          ...(secret ? {} : { defaultValue: values.value.value }),
          secret,
          source: "input",
        });
        step.value = `{{${name}}}`;
        step.clear = true;
      } else {
        step.value = values.value.value;
      }
    }
    if (kind === "key") {
      if (!values.key.value) {
        showError("Enter a key to press.");
        return;
      }
      step.key = values.key.value;
    }
    if (kind === "wait") {
      step.condition = values.waitCondition.value;
      if (step.condition === "timeout") step.ms = Number(values.ms.value);
      if (step.condition === "userOperation") step.prompt = values.prompt.value;
    }
    if (kind === "assert" || kind === "condition") {
      const assertionKind = values.assertionKind.value;
      const expected = values.expected.value;
      if (assertionKind === "text") {
        step.assertion = expected ? { kind: "text", equals: expected } : { kind: "text", contains: "" };
        if (!expected) {
          showError("Enter expected text.");
          return;
        }
      } else if (assertionKind === "value") {
        if (!expected) {
          showError("Enter the expected value.");
          return;
        }
        step.assertion = { kind: "value", equals: expected };
      } else if (assertionKind === "count") {
        const count = Number(expected);
        if (!Number.isInteger(count) || count < 0) {
          showError("Enter a non-negative integer count.");
          return;
        }
        step.assertion = { kind: "count", equals: count };
      } else {
        step.assertion = { kind: assertionKind };
      }
      if (kind === "condition") {
        if (values.trueStepId.value) step.trueStepId = values.trueStepId.value;
        if (values.falseStepId.value) step.falseStepId = values.falseStepId.value;
      }
    }
    if (kind === "switchTab") step.index = Number(values.tabIndex.value);
    if (kind === "closeTab" && values.tabIndex.value !== "") step.index = Number(values.tabIndex.value);
    if (kind === "dialog") step.action = values.dialogAction.value;
    if (kind === "scroll") step.delta = { x: 0, y: Number(values.deltaY.value) };
    if (kind === "upload") {
      const name = nextFlowVariableName(item.processFlow, "file");
      item.processFlow.variables ||= [];
      item.processFlow.variables.push({ name, type: "file", secret: false, source: "input" });
      step.files = [`{{${name}}}`];
    }
    if (kind === "extract") {
      const name = values.extra.value.trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        showError("Enter a valid extraction variable name.");
        return;
      }
      step.into = name;
      step.prop = "text";
    }
    // flow:updateSteps 的契约错误在对话框内联展示：先记录本地长度再提交，
    // 失败时回滚步骤与变量，磁盘 Flow 未变，用户输入原地保留可改后重试。
    const variablesBefore = item.processFlow.variables?.length ?? 0;
    const insertAt = group.steps.at(-1)?.kind === "condition"
      ? Math.min(insertAtIndex ?? group.steps.length, group.steps.length - 1)
      : insertAtIndex ?? group.steps.length;
    group.steps.splice(insertAt, 0, step);
    try {
      await persistProcessFlow(item);
      close();
      renderSummaryWorkspace();
    } catch (error) {
      group.steps.splice(insertAt, 1);
      if (item.processFlow.variables && item.processFlow.variables.length > variablesBefore)
        item.processFlow.variables.length = variablesBefore;
      showError(error instanceof Error ? error.message : String(error));
    }
  };
  form.elements.kind.focus();
}

let processCanvasObserver;
function bindProcessMap() {
  // Canvas 平移/缩放及分组操作仅属于当前视图；被选中的分组保存在录制项中，
  // 以便助手也能读取相同上下文。
  processCanvasObserver?.disconnect();
  const panel = $("summaryResultPanel"),
    canvas = panel?.querySelector(".process-canvas"),
    item = currentAssistantItem();
  if (!canvas || canvas.hidden || !item) return;
  const world = canvas.querySelector(".process-canvas-world");
  const placeGroupActions = () => {
    const group = [...canvas.querySelectorAll("[data-canvas-group]")].find(
        (element) => element.dataset.canvasGroup === item.selectedGroup,
      ),
      actions = [...canvas.querySelectorAll("[data-group-actions]")].find(
        (element) => element.dataset.groupActions === item.selectedGroup,
      );
    if (!group || !actions || actions.hidden) return;
    const canvasRect = canvas.getBoundingClientRect(),
      groupRect = group.getBoundingClientRect(),
      width = actions.offsetWidth,
      height = actions.offsetHeight,
      gap = 16;
    let left = groupRect.right - canvasRect.left + gap;
    if (left + width > canvas.clientWidth)
      left = groupRect.left - canvasRect.left - width - gap;
    left = Math.max(8, Math.min(canvas.clientWidth - width - 8, left));
    const top = Math.max(
      8,
      Math.min(canvas.clientHeight - height - 8, groupRect.top - canvasRect.top),
    );
    actions.style.left = `${left}px`;
    actions.style.top = `${top}px`;
  };
  let zoom = 1,
    x = 0,
    y = 0,
    drag = null;
  const paint = () => {
    world.style.transform = `translate(${x}px,${y}px) scale(${zoom})`;
    canvas.querySelector(".canvas-zoom-label").textContent =
      Math.round(zoom * 100) + "%";
    placeGroupActions();
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
  canvas.onclick = (e) => {
    if (!e.target.closest("#canvasStepMenu")) hideStepMenu();
    if (!e.target.closest("#canvasGroupMenu")) hideGroupMenu();
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
        group
          .querySelector(".canvas-group-heading")
          .setAttribute("aria-pressed", String(selected));
      });
      canvas.querySelectorAll("[data-group-actions]").forEach((actions) => {
        actions.hidden = actions.dataset.groupActions !== item.selectedGroup;
      });
      placeGroupActions();
      renderAIPanel();
    } else if (
      !e.target.closest(".canvas-view-controls,.canvas-group-actions")
    ) {
      item.selectedGroup = null;
      canvas.querySelectorAll("[data-canvas-group]").forEach((group) => {
        group.classList.remove("selected");
        group
          .querySelector(".canvas-group-heading")
          .setAttribute("aria-pressed", "false");
      });
      canvas
        .querySelectorAll("[data-group-actions]")
        .forEach((actions) => (actions.hidden = true));
      renderAIPanel();
    }
    const record = e.target.closest("[data-group-record]"),
      remove = e.target.closest("[data-group-delete]"),
      insert = e.target.closest("[data-group-insert]"),
      addStep = e.target.closest("[data-group-add-step]"),
      addAfter = e.target.closest("[data-group-add-after]"),
      rename = e.target.closest("[data-group-rename]"),
      move = e.target.closest("[data-group-move]"),
      merge = e.target.closest("[data-group-merge]"),
      ownerActions = e.target.closest("[data-group-actions]");
    if (addStep) {
      e.preventDefault();
      e.stopPropagation();
      showManualStepEditor(item, addStep.dataset.groupAddStep);
    }
    if (addAfter) {
      e.preventDefault();
      e.stopPropagation();
      void addProcessGroupAfter(item, addAfter.dataset.groupAddAfter);
    }
    if (rename && ownerActions) {
      e.preventDefault();
      e.stopPropagation();
      void renameProcessGroup(item, ownerActions.dataset.groupActions);
    }
    if (move && ownerActions) {
      e.preventDefault();
      e.stopPropagation();
      void moveProcessGroup(item, ownerActions.dataset.groupActions, move.dataset.groupMove);
    }
    if (merge && ownerActions) {
      e.preventDefault();
      e.stopPropagation();
      void mergeProcessGroupIntoNext(item, ownerActions.dataset.groupActions);
    }
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
        ".canvas-group,.canvas-view-controls,#canvasStepMenu,#canvasGroupMenu,.canvas-group-actions",
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
      // 菜单打开时 Esc 只关菜单，不触发画布取消选中等其它行为。
      if (!stepMenu.hidden || (groupMenu && !groupMenu.hidden)) {
        hideStepMenu();
        hideGroupMenu();
        return;
      }
      item.selectedGroup = null;
      canvas.querySelectorAll(".canvas-group").forEach((g) => {
        g.classList.remove("selected");
        g.querySelector(".canvas-group-heading").setAttribute(
          "aria-pressed",
          "false",
        );
      });
      canvas
        .querySelectorAll("[data-group-actions]")
        .forEach((actions) => (actions.hidden = true));
      renderAIPanel();
    }
  };
  const stepMenu = canvas.querySelector("#canvasStepMenu");
  const groupMenu = canvas.querySelector("#canvasGroupMenu");
  const hideStepMenu = () => {
    stepMenu.hidden = true;
    stepMenu.dataset.stepIndex = "";
  };
  const hideGroupMenu = () => {
    if (!groupMenu) return;
    groupMenu.hidden = true;
    groupMenu.dataset.groupId = "";
  };
  // 菜单 position:fixed，直接用视口坐标定位，右/下边界按视口夹取，
  // 彻底规避 world 的 translate/scale 换算与 canvas overflow:hidden 裁剪。
  const placeMenu = (menu, e) => {
    menu.hidden = false;
    const width = menu.offsetWidth || 160;
    const height = menu.offsetHeight || 200;
    menu.style.left =
      Math.max(8, Math.min(window.innerWidth - width - 8, e.clientX)) + "px";
    menu.style.top =
      Math.max(8, Math.min(window.innerHeight - height - 8, e.clientY)) + "px";
  };
  const showStepMenu = (e, stepIndex) => {
    e.preventDefault();
    e.stopPropagation();
    hideGroupMenu();
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
    placeMenu(stepMenu, e);
  };
  const showGroupMenu = (e, groupEl) => {
    e.preventDefault();
    e.stopPropagation();
    hideStepMenu();
    if (!groupMenu) return;
    const groupId = groupEl?.dataset.canvasGroup;
    const groups = ensureProcessGroups(item);
    const index = groups.findIndex((g) => g.id === groupId);
    if (index < 0) return;
    // 禁用规则与组操作按钮同源（见上方 setEditState 的 editBlockedReason）。
    const flowReady = Boolean(item.processFlow);
    const recordingNow = recordingSession().stage === "recording";
    const playbackActive =
      !!item.testRunning || recordingSession().playbackInFlight === true;
    const editBlockedReason = !flowReady
      ? item.processFlowError
        ? "The recorded Flow could not be loaded for this item."
        : "Loading the recorded Flow…"
      : recordingNow
        ? "Stop the recording to edit steps and groups."
        : playbackActive
          ? "Stop the running replay to edit steps and groups."
          : "";
    groupMenu.dataset.groupId = groupId;
    const setItem = (name, reason) => {
      const btn = groupMenu.querySelector(`[data-cmenu-group="${name}"]`);
      if (!btn) return;
      btn.disabled = Boolean(reason);
      btn.title = reason || "";
    };
    setItem("rename", editBlockedReason);
    setItem(
      "up",
      editBlockedReason ||
        (index === 0 ? "This is already the first group." : ""),
    );
    setItem(
      "down",
      editBlockedReason ||
        (index === groups.length - 1 ? "This is already the last group." : ""),
    );
    setItem(
      "merge",
      editBlockedReason ||
        (index === groups.length - 1
          ? "There is no group below to merge into."
          : ""),
    );
    setItem("delete", "");
    setItem("record", "");
    setItem("before", "");
    setItem("after", "");
    placeMenu(groupMenu, e);
  };
  canvas.oncontextmenu = (e) => {
    const step = e.target.closest(".canvas-step");
    if (step) {
      showStepMenu(e, step.dataset.canvasStepIndex);
      return false;
    }
    hideStepMenu();
    const groupEl = e.target.closest("[data-canvas-group]");
    if (groupEl) {
      showGroupMenu(e, groupEl);
      return false;
    }
    hideGroupMenu();
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
      // 已加载真实 Flow：在 processFlow.steps 上真实拆组（旧实现只改派生视图
      // 数组，而 ensureProcessGroups 每次从 steps 重建，拆分从未生效）。
      if (item.processFlow) {
        void (async () => {
          const flat = FlowGraph.flattenFlowSteps(item.processFlow.steps);
          const entry = flat.entries[stepIndex];
          const groupId = entry?.groupId;
          if (!entry || !groupId) return;
          const groupFirst = flat.entries.find((e2) => e2.groupId === groupId);
          const offset = stepIndex - (groupFirst?.index ?? stepIndex);
          const top = item.processFlow.steps.find(
            (s) => s.kind === "group" && s.id === groupId,
          );
          // 切点必须在组内：留出两个非空组
          if (!top || !Array.isArray(top.steps) || offset <= 0 || offset >= top.steps.length)
            return;
          let newId = `${groupId}-split-${Date.now().toString(36)}`;
          let seq = 2;
          while (item.processFlow.steps.some((s) => s && s.id === newId))
            newId = `${groupId}-split-${Date.now().toString(36)}-${seq++}`;
          const stepsBefore = item.processFlow.steps;
          const idx = stepsBefore.indexOf(top);
          const first = { ...top, steps: top.steps.slice(0, offset) };
          const second = { ...top, id: newId, steps: top.steps.slice(offset) };
          item.processFlow = {
            ...item.processFlow,
            steps: [
              ...stepsBefore.slice(0, idx),
              first,
              second,
              ...stepsBefore.slice(idx + 1),
            ],
          };
          try {
            // 走 flow.updateSteps 的完整校验；失败回滚，磁盘 Flow 未动
            await persistProcessFlow(item);
            item.selectedGroup = newId;
            renderSummaryWorkspace();
          } catch (error) {
            item.processFlow = { ...item.processFlow, steps: stepsBefore };
            syncProcessFlowPresentation(item);
            showFlowlinkNotice(
              "Split group failed: " +
                (error instanceof Error ? error.message : String(error)),
              "warn",
            );
          }
        })();
        return;
      }
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
  if (groupMenu)
    groupMenu.onclick = (e) => {
      e.stopPropagation();
      const groupId = groupMenu.dataset.groupId;
      if (!groupId) return;
      const btn = e.target.closest("[data-cmenu-group]");
      if (!btn || btn.disabled) return;
      const action = btn.dataset.cmenuGroup;
      hideGroupMenu();
      // 菜单项与组操作按钮同源：直接复用现有组操作函数（含确认流程）。
      if (action === "rename") void renameProcessGroup(item, groupId);
      else if (action === "up") void moveProcessGroup(item, groupId, "up");
      else if (action === "down")
        void moveProcessGroup(item, groupId, "down");
      else if (action === "merge")
        void mergeProcessGroupIntoNext(item, groupId);
      else if (action === "delete") deleteProcessGroup(item, groupId);
      else if (action === "record")
        beginGroupRecording(item, groupId, "replace");
      else if (action === "before")
        beginGroupRecording(item, groupId, "before");
      else if (action === "after")
        beginGroupRecording(item, groupId, "after");
    };
  requestAnimationFrame(fit);
}
async function beginGroupRecording(item, groupId, mode) {
  // 演示模式会为节点操作启动新的浏览器会话；Electron bridge 会改用前缀回放，
  // 将浏览器带到目标节点之前的状态。
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
    await window.flowlink.browser.closeTab(extra.nativeId || extra.id);
    state.browserTabs.pop();
  }
  state.activeBrowserTab = state.browserTabs[0].id;
  await window.flowlink.browser.switchTab("browser");
  const page = activeBrowserPage();
  let targetUrl = item.url || "";
  if (item.flowFile) {
    try {
      const flow = await window.flowlink.flow.load(item.flowFile);
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
async function finishGroupRecording(state, pending, item) {
  // 同步替换或插入步骤、详情和截图范围，再根据更新后的扁平步骤序列重建分组及测试 Flow 状态。
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
  if (item.processFlow) {
    const groupIndex = item.processFlow.steps.findIndex(
      (step) => step.kind === "group" && step.id === pending.groupId,
    );
    if (groupIndex >= 0 && steps.length) {
      const recordedFlowSteps = Array.isArray(pending.recordedFlowSteps)
        ? pending.recordedFlowSteps
        : (pending.recordedDetails || []).map((detail, index) =>
            stepDetailToFlowStep(
              detail,
              `rerecorded-${Date.now()}-${index}`,
              (Number(detail.tab) || 1) - 1,
            ),
          );
      const oldGroup = item.processFlow.steps[groupIndex];
      let position = group.start;
      if (pending.groupMode === "replace") {
        oldGroup.steps = recordedFlowSteps;
      } else {
        const after = pending.groupMode === "after";
        const newGroup = {
          kind: "group",
          id: `group_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
          label: `${after ? "After" : "Before"} ${oldGroup.label}`,
          steps: recordedFlowSteps,
        };
        item.processFlow.steps.splice(groupIndex + (after ? 1 : 0), 0, newGroup);
        if (after) position += group.count;
      }
      if (pending.media) {
        const screenshots = item.media?.screenshots || [];
        const inserted = pending.media.screenshots || [];
        const replacedCount = pending.groupMode === "replace" ? group.count : 0;
        const updated = [
          ...screenshots.slice(0, position),
          ...inserted,
          ...screenshots.slice(position + replacedCount),
        ];
        item.media = { ...(item.media || {}), screenshots: updated };
      }
      try {
        await persistProcessFlow(item);
      } catch (error) {
        item.processFlowError = error instanceof Error ? error.message : String(error);
        console.error("[process] Unable to save re-recorded group:", error);
      }
      const currentGroups = ensureProcessGroups(item);
      const selected = currentGroups.find((candidate) => candidate.start <= position && position < candidate.start + candidate.count);
      item.selectedGroup = selected?.id || item.processFlow.steps[0]?.id || null;
    }
    item.resultTab = "Process";
    state.focused = item.id;
    state.view = "analysis";
    state.stage = "done";
    state.pending = null;
    renderRecordingWorkspace();
    if (window.flowlink?.browser?.hide) window.flowlink.browser.hide();
    return;
  }
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
  if (item.processFlow) {
    const groups = item.processFlow.steps.filter((step) => step.kind === "group");
    const groupIndex = item.processFlow.steps.findIndex(
      (step) => step.kind === "group" && step.id === groupId,
    );
    if (groupIndex < 0) return;
    if (groups.length <= 1) {
      await showWorkspaceNotice("A Flow must keep at least one group.");
      return;
    }
    if (
      !(await confirmWorkspaceAction(
        `Delete group “${groups.find((group) => group.id === groupId)?.label}” and its steps? Branches pointing into it will fall back to sequential continuation.`,
      ))
    )
      return;
    const removedIds = stepIdsOf(groups.find((group) => group.id === groupId));
    item.processFlow.steps.splice(groupIndex, 1);
    clearDanglingBranchRefs(item.processFlow.steps, removedIds);
    item.selectedGroup = null;
    try {
      await persistProcessFlow(item);
      renderSummaryWorkspace();
    } catch (error) {
      item.processFlowError = error instanceof Error ? error.message : String(error);
      renderSummaryWorkspace();
    }
    return;
  }
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

/* 分组操作（重命名 / 上移下移 / 并入下一组）都走 flow:updateSteps 校验保存；
 * 01/02 编号是 ensureProcessGroups 的派生值，保存后重渲染即自动重算。 */
async function renameProcessGroup(item, groupId) {
  const group = item.processFlow?.steps.find(
    (step) => step.kind === "group" && step.id === groupId,
  );
  if (!group) return;
  const label = await showProcessGroupDialog({
    title: "Rename group",
    name: group.label,
  });
  if (!label || label === group.label) return;
  group.label = label;
  try {
    await persistProcessFlow(item);
  } catch (error) {
    item.processFlowError = error instanceof Error ? error.message : String(error);
  }
  renderSummaryWorkspace();
}

async function moveProcessGroup(item, groupId, direction) {
  const steps = item.processFlow?.steps || [];
  const groups = steps.filter((step) => step.kind === "group");
  const position = groups.findIndex((group) => group.id === groupId);
  const swapWith = direction === "up" ? position - 1 : position + 1;
  if (position < 0 || swapWith < 0 || swapWith >= groups.length) return;
  const a = steps.indexOf(groups[position]);
  const b = steps.indexOf(groups[swapWith]);
  [steps[a], steps[b]] = [steps[b], steps[a]];
  item.selectedGroup = groupId;
  try {
    await persistProcessFlow(item);
  } catch (error) {
    item.processFlowError = error instanceof Error ? error.message : String(error);
  }
  renderSummaryWorkspace();
}

async function mergeProcessGroupIntoNext(item, groupId) {
  const steps = item.processFlow?.steps || [];
  const groups = steps.filter((step) => step.kind === "group");
  const position = groups.findIndex((group) => group.id === groupId);
  if (position < 0 || position >= groups.length - 1) return;
  const current = groups[position];
  const next = groups[position + 1];
  // 契约已放宽：condition 可位于组内任意位置，尾置 condition 的组并入
  // 下一组同样合法（分支目标是步骤 id，不随组结构变化悬空）。
  if (
    !(await confirmWorkspaceAction(
      `Merge “${current.label}” into “${next.label}”? The merged group keeps the name “${next.label}”.`,
    ))
  )
    return;
  next.steps = [...current.steps, ...next.steps];
  steps.splice(steps.indexOf(current), 1);
  item.selectedGroup = next.id;
  try {
    await persistProcessFlow(item);
  } catch (error) {
    item.processFlowError = error instanceof Error ? error.message : String(error);
  }
  renderSummaryWorkspace();
}

// 以不压缩方式下载 ZIP，保留每个原始文件的字节内容和文件名。
async function downloadReferenceArchive(item) {
  const files = ensureReferenceFiles(item)
    .filter((reference) => reference.selected)
    .map((reference) => ({
      name: reference.kind === "variable" ? `${reference.name}.txt` : reference.name,
      file:
        reference.kind === "variable"
          ? new Blob([`Name: ${reference.name}\r\nType: ${reference.variableType || "string"}\r\nValue: ${reference.value || ""}\r\n`], { type: "text/plain;charset=utf-8" })
          : reference.file,
    }));
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

// 仅捕获本地嵌入式演示内容，不录制外部源的屏幕。
function embeddedSnapshotBridge() {
  // 此 bridge 在本地演示 iframe 内运行，将可见 DOM 绘制为 PNG，
  // 并只向父页面发送长度受限的交互标签。
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
  // 原型只捕获本地生成的 canvas，不读取任意跨域 iframe 像素；
  // 截图通过 snapshot 消息传入。
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
  // 停止轨道前先请求最后一帧；媒体录制器异步关闭，因此需等待 onstop 后
  // 再释放生成的对象 URL。
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
// 使用原生指针和键盘调整尺寸，不额外添加布局标签或图标。
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
  // 工作区 DOM 移动后重新绑定，并通过 ResizeObserver 使分隔条当前值和无障碍范围
  // 始终符合可用空间。
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
  // 助手面板宽度按录制会话保存，切换视图时不会丢失用户调整；
  // 指针和键盘输入共用同一限幅规则。默认宽度为 Material 列表宽度的 1.7 倍。
  const separator = $("assistantResize");
  const session = recordingSession();
  if (!session.aiWidth) {
    const listWidth =
      session.listWidth ||
      document
        .querySelector(
          "#designPanel .recording-layout:not([hidden]) .recording-list",
        )
        ?.getBoundingClientRect().width ||
      298;
    session.aiWidth = listWidth * 1.7;
  }
  setAssistantWidth(session.aiWidth);
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
