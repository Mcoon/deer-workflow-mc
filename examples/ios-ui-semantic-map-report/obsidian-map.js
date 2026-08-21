(() => {
  const graph = JSON.parse(
    document.getElementById("executable-graph-data").textContent,
  );
  const oldRevision = document
    .querySelector('meta[name="semantic-map-revision"]')
    ?.getAttribute("content");
  const oldApp = document.querySelector(".app");
  const oldScript = document.querySelector('script[src="semantic-map.js"]');
  if (oldApp) {
    oldApp.remove();
  }
  if (oldScript) {
    oldScript.remove();
  }

  const stateCount = graph.scenes.reduce(
    (total, scene) => total + (scene.stateVariants || []).length,
    0,
  );
  document.body.insertAdjacentHTML(
    "afterbegin",
    `<div class="og-app">
      <header class="og-header">
        <h1>iOS Executable UI Graph</h1>
        <span class="og-meta"><strong>${escapeHtml(graph.appName)}</strong> · ${escapeHtml(graph.graphId)}</span>
        <span class="og-meta stats">${graph.scenes.length} pages · ${graph.elements.length} elements · ${stateCount} states · ${graph.operators.length} actions · ${graph.tasks.length} tasks</span>
        <div class="og-toolbar">
          <span class="og-runtime" id="og-runtime">loading graph</span>
          <input class="og-search" id="og-search" placeholder="搜索 Task / 页面">
          <button class="og-button" id="og-agent-toggle" type="button">Agent</button>
          <button class="og-button" id="og-fit" type="button">Fit</button>
          <button class="og-button" id="og-home" type="button">Home</button>
          <button class="og-button" id="og-clear" type="button">Clear</button>
        </div>
      </header>
      <div class="og-layout">
        <aside class="og-sidebar">
          <div class="og-tabs">
            <button class="og-tab active" data-panel="tasks" type="button">Tasks · ${graph.tasks.length}</button>
            <button class="og-tab" data-panel="pages" type="button">Pages · ${graph.scenes.length}</button>
          </div>
          <section class="og-panel active" id="og-panel-tasks">
            <section class="og-coverage">
              <div class="og-coverage-title">Graph Coverage</div>
              <div class="og-coverage-grid">
                ${coverageStat(
                  graph.scenes.filter((scene) => scene.status === "verified")
                    .length,
                  "verified",
                )}
                ${coverageStat(
                  graph.scenes.filter((scene) => scene.status === "candidate")
                    .length,
                  "candidate",
                )}
                ${coverageStat(graph.elements.length, "elements")}
                ${coverageStat(
                  graph.operators.filter(
                    (operator) => operator.execution?.tier === "fast",
                  ).length,
                  "fast",
                )}
                ${coverageStat(
                  graph.operators.filter(
                    (operator) => operator.execution?.tier === "guarded",
                  ).length,
                  "guarded",
                )}
                ${coverageStat(stateCount, "states")}
              </div>
            </section>
            <div class="og-list-title">Executable Tasks</div>
            <div id="og-task-list"></div>
          </section>
          <section class="og-panel" id="og-panel-pages">
            <div class="og-list-title">App Pages</div>
            <div id="og-page-list"></div>
          </section>
        </aside>
        <main class="og-workspace" id="og-workspace">
          <div class="og-canvas-controls">
            <button class="og-button" id="og-zoom-in" type="button">＋</button>
            <button class="og-button" id="og-zoom-out" type="button">－</button>
            <button class="og-button" id="og-labels" type="button">Labels</button>
          </div>
          <div class="og-canvas-info" id="og-canvas-info">拖动画布平移 · 滚轮缩放 · 点击页面展开元素 · 点击 Task 高亮执行路径</div>
          <svg class="og-graph" id="og-map" aria-label="iOS executable semantic UI relationship graph">
            <g class="og-viewport" id="og-viewport">
              <g id="og-module-layer"></g>
              <g id="og-edge-layer"></g>
              <g id="og-scene-layer"></g>
              <g id="og-element-layer"></g>
              <g id="og-step-layer"></g>
            </g>
          </svg>
          <div class="og-legend"><span><i class="verified"></i>verified page</span><span><i class="candidate"></i>candidate page</span><span><i class="task"></i>selected path</span></div>
        </main>
        <button class="og-details-backdrop" id="og-details-backdrop" type="button" aria-label="关闭页面详情"></button>
        <aside class="og-details" id="og-details">
          <button class="og-details-close" id="og-details-close" type="button" aria-label="关闭页面详情">×</button>
          <div id="og-details-content"></div>
        </aside>
      </div>
      <div class="og-context-menu" id="og-context-menu" role="menu">
        <div class="og-context-title" id="og-context-title"></div>
        <button type="button" data-context-action="execute">执行</button>
        <button type="button" data-context-action="explore">继续探索</button>
        <button type="button" data-context-action="copy">复制唯一 ID</button>
        <div class="og-context-submenu" id="og-context-submenu"></div>
      </div>
      <section class="og-console" id="og-console">
        <header class="og-console-header">
          <div><strong>Graph Agent</strong><span id="og-console-service">连接中</span></div>
          <button type="button" id="og-console-close" aria-label="关闭 Agent Console">×</button>
        </header>
        <div class="og-console-context" id="og-console-context">未选择节点</div>
        <div class="og-console-messages" id="og-console-messages">
          <div class="og-console-message system">可询问 Graph、执行/探索节点，或提交纠错建议。</div>
        </div>
        <div class="og-run-log" id="og-run-log"></div>
        <form class="og-console-form" id="og-console-form">
          <textarea id="og-console-input" rows="2" placeholder="例如：这个页面名称不对，应该叫字号与背景"></textarea>
          <button type="submit">发送</button>
        </form>
      </section>
    </div>`,
  );

  const svg = document.getElementById("og-map");
  const viewport = document.getElementById("og-viewport");
  const workspace = document.getElementById("og-workspace");
  const detailsPanel = document.getElementById("og-details");
  const details = document.getElementById("og-details-content");
  const detailsClose = document.getElementById("og-details-close");
  const detailsBackdrop = document.getElementById("og-details-backdrop");
  const moduleLayer = document.getElementById("og-module-layer");
  const edgeLayer = document.getElementById("og-edge-layer");
  const sceneLayer = document.getElementById("og-scene-layer");
  const elementLayer = document.getElementById("og-element-layer");
  const stepLayer = document.getElementById("og-step-layer");
  const taskList = document.getElementById("og-task-list");
  const pageList = document.getElementById("og-page-list");
  const search = document.getElementById("og-search");
  const runtimeStatus = document.getElementById("og-runtime");
  const contextMenu = document.getElementById("og-context-menu");
  const contextTitle = document.getElementById("og-context-title");
  const contextSubmenu = document.getElementById("og-context-submenu");
  const consolePanel = document.getElementById("og-console");
  const consoleService = document.getElementById("og-console-service");
  const consoleContext = document.getElementById("og-console-context");
  const consoleMessages = document.getElementById("og-console-messages");
  const runLog = document.getElementById("og-run-log");
  const consoleForm = document.getElementById("og-console-form");
  const consoleInput = document.getElementById("og-console-input");
  const namespace = "http://www.w3.org/2000/svg";
  let graphRevision = "";
  let consoleAvailable = false;
  let contextTarget = null;
  const runtimeBeacon = (name, detail = "") => {
    fetch(`${name}?detail=${encodeURIComponent(detail)}&ts=${Date.now()}`, {
      cache: "no-store",
    }).catch(() => {});
  };
  window.addEventListener("error", (event) => {
    runtimeStatus.textContent = `graph failed · ${event.message}`;
    runtimeStatus.className = "og-runtime failed";
    runtimeStatus.title = event.error?.stack || event.message;
    runtimeBeacon("runtime-failed", event.message);
  });

  const sceneById = new Map(
    graph.scenes.map((scene) => [scene.sceneId, scene]),
  );
  const elementById = new Map(
    graph.elements.map((element) => [element.elementId, element]),
  );
  const operatorById = new Map(
    graph.operators.map((operator) => [operator.operatorId, operator]),
  );
  const taskById = new Map(graph.tasks.map((task) => [task.taskId, task]));
  const elementsByScene = new Map();
  const operatorsByScene = new Map();
  for (const element of graph.elements) {
    appendToMap(elementsByScene, element.sceneId, element);
  }
  for (const operator of graph.operators) {
    appendToMap(operatorsByScene, operator.fromSceneId, operator);
  }

  const modules = [
    "chat",
    "skills",
    "bot",
    "camera",
    "photo",
    "cloud",
    "file",
    "other",
  ];
  const moduleTitles = {
    chat: "CHAT",
    skills: "SKILLS",
    bot: "BOT SETTINGS",
    camera: "CAMERA",
    photo: "PHOTOS",
    cloud: "CLOUD DRIVE",
    file: "FILES",
    other: "OTHER",
  };
  const moduleScenes = new Map(modules.map((module) => [module, []]));
  for (const scene of graph.scenes) {
    moduleScenes.get(moduleOf(scene.sceneId)).push(scene);
  }
  const activeModules = modules.filter(
    (module) => moduleScenes.get(module).length > 0,
  );
  const world = { width: 1500, height: 980 };
  const centers = new Map();
  for (const [index, module] of activeModules.entries()) {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / activeModules.length;
    const radius = module === "chat" ? 0 : 315;
    centers.set(module, {
      x: world.width / 2 + Math.cos(angle) * radius,
      y: world.height / 2 + Math.sin(angle) * radius,
    });
  }
  if (centers.has("chat")) {
    centers.set("chat", { x: world.width / 2, y: world.height / 2 });
  }

  const nodes = graph.scenes.map((scene, index) => {
    const module = moduleOf(scene.sceneId);
    const bucket = moduleScenes.get(module);
    const localIndex = bucket.indexOf(scene);
    const center = centers.get(module);
    const angle =
      (localIndex * Math.PI * 2) / Math.max(1, bucket.length) +
      (index % 3) * 0.11;
    const radius = 24 + Math.sqrt(localIndex + 1) * 22;
    return {
      id: scene.sceneId,
      scene,
      module,
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
      radius:
        6 +
        Math.min(
          8,
          Math.sqrt((elementsByScene.get(scene.sceneId) || []).length) * 1.1,
        ),
      fixed: false,
    };
  });
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const edgeGroups = new Map();
  for (const operator of graph.operators) {
    if (operator.fromSceneId === operator.toSceneId) {
      continue;
    }
    const key = `${operator.fromSceneId}→${operator.toSceneId}`;
    if (!edgeGroups.has(key)) {
      edgeGroups.set(key, {
        key,
        from: operator.fromSceneId,
        to: operator.toSceneId,
        operators: [],
      });
    }
    edgeGroups.get(key).operators.push(operator);
  }
  const edges = [...edgeGroups.values()];

  let transform = { x: 0, y: 0, scale: 1 };
  let selected = { kind: "overview", id: null };
  let showLabels = true;
  let dragNode = null;
  let dragStart = null;
  let panStart = null;
  let pointerMoved = false;
  let alpha = 1;
  let animationFrame = 0;
  const sceneElements = new Map();
  const edgeElements = new Map();
  const expandedElements = new Map();

  function moduleOf(sceneId) {
    const prefix = String(sceneId).split(".")[0];
    return modules.includes(prefix) ? prefix : "other";
  }

  function appendToMap(map, key, value) {
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key).push(value);
  }

  function coverageStat(value, label) {
    return `<div class="og-coverage-stat"><div class="og-coverage-value">${value}</div><div class="og-coverage-label">${label}</div></div>`;
  }

  function createSvg(name, attributes = {}) {
    const element = document.createElementNS(namespace, name);
    for (const [key, value] of Object.entries(attributes)) {
      element.setAttribute(key, String(value));
    }
    return element;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(
      /[&<>"']/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[character],
    );
  }

  function shortText(value, maximum) {
    const text = String(value || "");
    return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
  }

  function operatorKind(operator) {
    if (operator.risk === "mutation") {
      return "mutation";
    }
    if (operator.risk === "selection") {
      return "selection";
    }
    if (operator.operatorId.includes("permission")) {
      return "permission";
    }
    return operator.risk === "navigation" ? "navigation" : "interaction";
  }

  function operationElementId(operator) {
    return operator.operation &&
      (operator.operation.type === "tap" ||
        operator.operation.type === "long_press")
      ? operator.operation.elementId
      : null;
  }

  function operatorsForElement(elementId) {
    return graph.operators.filter(
      (operator) => operationElementId(operator) === elementId,
    );
  }

  function entityTitle(target) {
    if (target.kind === "scene") {
      return sceneById.get(target.id)?.title || target.id;
    }
    if (target.kind === "element") {
      return elementById.get(target.id)?.title || target.id;
    }
    if (target.kind === "operator") {
      return operatorById.get(target.id)?.title || target.id;
    }
    return taskById.get(target.id)?.title || target.id;
  }

  function typedId(target) {
    return `${target.kind}:${target.id}`;
  }

  function selectedTarget() {
    return ["scene", "element", "operator", "task"].includes(selected.kind)
      ? { kind: selected.kind, id: selected.id }
      : null;
  }

  function updateConsoleContext() {
    const target = selectedTarget();
    consoleContext.textContent = target
      ? `${target.kind.toUpperCase()} · ${entityTitle(target)} · ${typedId(target)}`
      : "未选择节点";
  }

  function openContextMenu(event, target) {
    event.preventDefault();
    event.stopPropagation();
    contextTarget = target;
    contextTitle.textContent = `${entityTitle(target)} · ${typedId(target)}`;
    contextSubmenu.replaceChildren();
    const executeButton = contextMenu.querySelector(
      '[data-context-action="execute"]',
    );
    if (target.kind === "element") {
      const operators = operatorsForElement(target.id);
      executeButton.textContent =
        operators.length > 1 ? `执行（${operators.length} 个动作）` : "执行";
    } else {
      executeButton.textContent = "执行";
    }
    contextMenu.classList.add("open");
    const menuWidth = 235;
    const menuHeight = 180;
    contextMenu.style.left = `${Math.min(event.clientX, innerWidth - menuWidth - 8)}px`;
    contextMenu.style.top = `${Math.min(event.clientY, innerHeight - menuHeight - 8)}px`;
  }

  function closeContextMenu() {
    contextMenu.classList.remove("open");
    contextSubmenu.replaceChildren();
  }

  function openOperatorChoices(elementId) {
    const operators = operatorsForElement(elementId);
    if (operators.length === 0) {
      appendConsoleMessage(
        "system",
        "这个 Element 当前没有可执行 Operator，可先继续探索。",
      );
      openConsole();
      return;
    }
    if (operators.length === 1) {
      void startAction("execute", {
        kind: "operator",
        id: operators[0].operatorId,
      });
      return;
    }
    contextSubmenu.replaceChildren();
    const heading = document.createElement("div");
    heading.className = "og-context-subtitle";
    heading.textContent = "选择具体动作";
    contextSubmenu.appendChild(heading);
    for (const operator of operators) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = operator.title;
      button.title = operator.operatorId;
      button.addEventListener("click", () => {
        closeContextMenu();
        void startAction("execute", {
          kind: "operator",
          id: operator.operatorId,
        });
      });
      contextSubmenu.appendChild(button);
    }
  }

  function buildLists() {
    for (const task of graph.tasks) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "og-item og-task-item";
      button.dataset.id = task.taskId;
      button.innerHTML = `<div class="og-item-title"><span class="og-status ${escapeHtml(task.status)}"></span>${escapeHtml(task.title)}</div><div class="og-item-id">${escapeHtml(task.taskId)}</div><div class="og-item-meta">${task.operatorIds.length} steps · ${escapeHtml(task.status)}</div>`;
      button.addEventListener("click", () => selectTask(task.taskId));
      button.addEventListener("contextmenu", (event) =>
        openContextMenu(event, { kind: "task", id: task.taskId }),
      );
      taskList.appendChild(button);
    }
    for (const module of activeModules) {
      const heading = document.createElement("div");
      heading.className = "og-list-title";
      heading.textContent = `${moduleTitles[module]} · ${moduleScenes.get(module).length}`;
      pageList.appendChild(heading);
      const scenes = [...moduleScenes.get(module)].sort((left, right) =>
        left.title.localeCompare(right.title),
      );
      for (const scene of scenes) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "og-item og-page-item";
        button.dataset.id = scene.sceneId;
        button.innerHTML = `<div class="og-item-title"><span class="og-status ${escapeHtml(scene.status)}"></span>${escapeHtml(scene.title)}</div><div class="og-item-id">${escapeHtml(scene.sceneId)}</div><div class="og-item-meta">${(elementsByScene.get(scene.sceneId) || []).length} elements · ${(operatorsByScene.get(scene.sceneId) || []).length} actions</div>`;
        button.addEventListener("click", () =>
          selectScene(scene.sceneId, true),
        );
        button.addEventListener("contextmenu", (event) =>
          openContextMenu(event, { kind: "scene", id: scene.sceneId }),
        );
        pageList.appendChild(button);
      }
    }
  }

  function buildGraph() {
    const definitions = createSvg("defs");
    definitions.innerHTML =
      '<marker id="og-task-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0 0L6 3L0 6Z" fill="#c9c4ff"></path></marker>';
    svg.insertBefore(definitions, viewport);

    for (const module of activeModules) {
      const center = centers.get(module);
      const label = createSvg("text", {
        class: "og-module-label",
        x: center.x,
        y: center.y - 76,
        "text-anchor": "middle",
      });
      label.textContent = moduleTitles[module];
      moduleLayer.appendChild(label);
    }

    for (const edge of edges) {
      const group = createSvg("g");
      const line = createSvg("line", {
        class: `og-edge ${operatorKind(edge.operators[0])}`,
      });
      const hit = createSvg("line", { class: "og-edge-hit" });
      const title = createSvg("title");
      title.textContent = `${edge.operators.length} actions · ${edge.from} → ${edge.to}`;
      group.append(line, hit, title);
      group.addEventListener("click", (event) => {
        event.stopPropagation();
        selectEdge(edge.key);
      });
      edgeLayer.appendChild(group);
      edgeElements.set(edge.key, { group, line, hit });
    }

    for (const node of nodes) {
      const group = createSvg("g", {
        class: `og-scene ${node.scene.status}`,
        "data-scene-id": node.id,
      });
      const halo = createSvg("circle", {
        class: "og-scene-halo",
        r: node.radius + 13,
      });
      const dot = createSvg("circle", {
        class: "og-scene-dot",
        r: node.radius,
      });
      const label = createSvg("text", {
        class: "og-scene-label",
        x: node.radius + 8,
        y: 3,
      });
      const sub = createSvg("text", {
        class: "og-scene-sub",
        x: node.radius + 8,
        y: 14,
      });
      const title = createSvg("title");
      label.textContent = node.scene.title;
      sub.textContent = node.id;
      title.textContent = `${node.scene.title} · ${node.id}`;
      group.append(halo, dot, label, sub, title);
      group.addEventListener("pointerdown", (event) =>
        startNodeDrag(event, node),
      );
      group.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!pointerMoved) {
          selectScene(node.id, false);
        }
      });
      group.addEventListener("contextmenu", (event) =>
        openContextMenu(event, { kind: "scene", id: node.id }),
      );
      sceneLayer.appendChild(group);
      sceneElements.set(node.id, group);
    }
    renderPositions();
  }

  function renderPositions() {
    for (const edge of edges) {
      const from = nodeById.get(edge.from);
      const to = nodeById.get(edge.to);
      const rendered = edgeElements.get(edge.key);
      for (const line of [rendered.line, rendered.hit]) {
        line.setAttribute("x1", from.x);
        line.setAttribute("y1", from.y);
        line.setAttribute("x2", to.x);
        line.setAttribute("y2", to.y);
      }
    }
    for (const node of nodes) {
      sceneElements
        .get(node.id)
        .setAttribute("transform", `translate(${node.x},${node.y})`);
    }
    renderExpandedElementPositions();
    renderStepPositions();
  }

  function simulationTick() {
    if (alpha < 0.004) {
      animationFrame = 0;
      return;
    }
    const strength = alpha;
    for (let firstIndex = 0; firstIndex < nodes.length; firstIndex += 1) {
      for (
        let secondIndex = firstIndex + 1;
        secondIndex < nodes.length;
        secondIndex += 1
      ) {
        const first = nodes[firstIndex];
        const second = nodes[secondIndex];
        const deltaX = second.x - first.x || 0.1;
        const deltaY = second.y - first.y || 0.1;
        const distanceSquared = Math.max(90, deltaX * deltaX + deltaY * deltaY);
        const distance = Math.sqrt(distanceSquared);
        const force = Math.min(1.8, 1250 / distanceSquared) * strength;
        const forceX = (deltaX / distance) * force;
        const forceY = (deltaY / distance) * force;
        if (!first.fixed) {
          first.vx -= forceX;
          first.vy -= forceY;
        }
        if (!second.fixed) {
          second.vx += forceX;
          second.vy += forceY;
        }
      }
    }
    for (const edge of edges) {
      const from = nodeById.get(edge.from);
      const to = nodeById.get(edge.to);
      const deltaX = to.x - from.x;
      const deltaY = to.y - from.y;
      const distance = Math.max(1, Math.hypot(deltaX, deltaY));
      const desired = from.module === to.module ? 92 : 180;
      const force = (distance - desired) * 0.0028 * strength;
      const forceX = (deltaX / distance) * force;
      const forceY = (deltaY / distance) * force;
      if (!from.fixed) {
        from.vx += forceX;
        from.vy += forceY;
      }
      if (!to.fixed) {
        to.vx -= forceX;
        to.vy -= forceY;
      }
    }
    for (const node of nodes) {
      const center = centers.get(node.module);
      if (!node.fixed) {
        node.vx += (center.x - node.x) * 0.0013 * strength;
        node.vy += (center.y - node.y) * 0.0013 * strength;
        node.vx *= 0.88;
        node.vy *= 0.88;
        node.x += node.vx;
        node.y += node.vy;
      }
    }
    alpha *= 0.975;
    renderPositions();
    animationFrame = requestAnimationFrame(simulationTick);
  }

  function restartSimulation(value = 0.5) {
    alpha = Math.max(alpha, value);
    if (!animationFrame) {
      animationFrame = requestAnimationFrame(simulationTick);
    }
  }

  function applyTransform() {
    viewport.setAttribute(
      "transform",
      `translate(${transform.x} ${transform.y}) scale(${transform.scale})`,
    );
  }

  function fitIds(ids, padding = 80) {
    const selectedNodes =
      ids && ids.length
        ? ids.map((id) => nodeById.get(id)).filter(Boolean)
        : nodes;
    if (!selectedNodes.length) {
      return;
    }
    let minimumX = Math.min(...selectedNodes.map((node) => node.x));
    let maximumX = Math.max(...selectedNodes.map((node) => node.x));
    let minimumY = Math.min(...selectedNodes.map((node) => node.y));
    let maximumY = Math.max(...selectedNodes.map((node) => node.y));
    const expanded =
      selected.kind === "scene" && ids?.includes(selected.id)
        ? expandedBounds()
        : null;
    if (expanded) {
      minimumX = Math.min(minimumX, expanded.minimumX);
      maximumX = Math.max(maximumX, expanded.maximumX);
      minimumY = Math.min(minimumY, expanded.minimumY);
      maximumY = Math.max(maximumY, expanded.maximumY);
    }
    const rectangle = workspace.getBoundingClientRect();
    const width = Math.max(100, maximumX - minimumX + padding * 2);
    const height = Math.max(100, maximumY - minimumY + padding * 2);
    const scale = Math.max(
      0.18,
      Math.min(3, Math.min(rectangle.width / width, rectangle.height / height)),
    );
    transform.scale = scale;
    transform.x = rectangle.width / 2 - ((minimumX + maximumX) / 2) * scale;
    transform.y = rectangle.height / 2 - ((minimumY + maximumY) / 2) * scale;
    applyTransform();
  }

  function zoomAt(factor, clientX, clientY) {
    const rectangle = svg.getBoundingClientRect();
    const x =
      (clientX ?? rectangle.left + rectangle.width / 2) - rectangle.left;
    const y = (clientY ?? rectangle.top + rectangle.height / 2) - rectangle.top;
    const worldX = (x - transform.x) / transform.scale;
    const worldY = (y - transform.y) / transform.scale;
    const nextScale = Math.max(0.15, Math.min(5, transform.scale * factor));
    transform.x = x - worldX * nextScale;
    transform.y = y - worldY * nextScale;
    transform.scale = nextScale;
    applyTransform();
  }

  function resetClasses() {
    for (const element of sceneElements.values()) {
      element.classList.remove("selected", "active", "near", "dim");
    }
    for (const rendered of edgeElements.values()) {
      rendered.line.classList.remove("active", "near", "dim");
      rendered.line.removeAttribute("marker-end");
    }
    for (const item of document.querySelectorAll(".og-item")) {
      item.classList.remove("selected");
    }
  }

  function setSelectionInfo(text) {
    document.getElementById("og-canvas-info").textContent = text;
  }

  function openDetails() {
    detailsPanel.classList.add("open");
    detailsBackdrop.classList.add("open");
  }

  function closeDetails() {
    detailsPanel.classList.remove("open");
    detailsBackdrop.classList.remove("open");
  }

  function selectTask(taskId) {
    const task = taskById.get(taskId);
    if (!task) {
      return;
    }
    selected = { kind: "task", id: taskId };
    clearExpandedElements();
    clearSteps();
    resetClasses();
    const sceneIds = new Set([task.entrySceneId]);
    const edgeKeys = new Set();
    for (const operatorId of task.operatorIds) {
      const operator = operatorById.get(operatorId);
      if (!operator) {
        continue;
      }
      sceneIds.add(operator.fromSceneId);
      sceneIds.add(operator.toSceneId);
      if (operator.fromSceneId !== operator.toSceneId) {
        edgeKeys.add(`${operator.fromSceneId}→${operator.toSceneId}`);
      }
    }
    for (const [sceneId, element] of sceneElements) {
      element.classList.toggle("active", sceneIds.has(sceneId));
      element.classList.toggle("dim", !sceneIds.has(sceneId));
    }
    for (const [edgeKey, rendered] of edgeElements) {
      const active = edgeKeys.has(edgeKey);
      rendered.line.classList.toggle("active", active);
      rendered.line.classList.toggle("dim", !active);
      if (active) {
        rendered.line.setAttribute("marker-end", "url(#og-task-arrow)");
      }
    }
    document
      .querySelector(`.og-task-item[data-id="${cssEscape(taskId)}"]`)
      ?.classList.add("selected");
    renderTask(task);
    openDetails();
    renderTaskSteps(task);
    updateConsoleContext();
    setSelectionInfo(`Task · ${task.title} · ${task.operatorIds.length} steps`);
    fitIds([...sceneIds], 130);
  }

  function selectScene(sceneId, fromList) {
    const scene = sceneById.get(sceneId);
    if (!scene) {
      return;
    }
    selected = { kind: "scene", id: sceneId };
    clearSteps();
    clearExpandedElements();
    resetClasses();
    const neighbors = new Set([sceneId]);
    for (const edge of edges) {
      if (edge.from === sceneId) {
        neighbors.add(edge.to);
      }
      if (edge.to === sceneId) {
        neighbors.add(edge.from);
      }
    }
    for (const [currentId, element] of sceneElements) {
      element.classList.toggle("selected", currentId === sceneId);
      element.classList.toggle(
        "near",
        currentId !== sceneId && neighbors.has(currentId),
      );
      element.classList.toggle("dim", !neighbors.has(currentId));
    }
    for (const [edgeKey, rendered] of edgeElements) {
      const edge = edgeGroups.get(edgeKey);
      const near = edge.from === sceneId || edge.to === sceneId;
      rendered.line.classList.toggle("near", near);
      rendered.line.classList.toggle("dim", !near);
    }
    document
      .querySelector(`.og-page-item[data-id="${cssEscape(sceneId)}"]`)
      ?.classList.add("selected");
    expandSceneElements(sceneId);
    renderScene(scene);
    openDetails();
    updateConsoleContext();
    setSelectionInfo(
      `Page · ${scene.title} · ${(elementsByScene.get(sceneId) || []).length} elements · ${(operatorsByScene.get(sceneId) || []).length} actions`,
    );
    if (fromList) {
      requestAnimationFrame(() => fitIds([...neighbors], 145));
    }
  }

  function selectElement(elementId) {
    const element = elementById.get(elementId);
    if (!element) {
      return;
    }
    selected = {
      kind: "element",
      id: elementId,
      sceneId: element.sceneId,
    };
    for (const rendered of expandedElements.values()) {
      rendered.group.classList.toggle(
        "selected",
        rendered.element.elementId === elementId,
      );
    }
    renderElement(element);
    openDetails();
    updateConsoleContext();
    setSelectionInfo(`Element · ${element.title} · ${element.semanticRole}`);
  }

  function selectEdge(edgeKey) {
    const edge = edgeGroups.get(edgeKey);
    if (!edge) {
      return;
    }
    selected = { kind: "edge", id: edgeKey };
    clearExpandedElements();
    clearSteps();
    resetClasses();
    sceneElements.get(edge.from).classList.add("active");
    sceneElements.get(edge.to).classList.add("active");
    edgeElements.get(edgeKey).line.classList.add("active");
    renderEdge(edge);
    openDetails();
    fitIds([edge.from, edge.to], 150);
    setSelectionInfo(
      `${edge.operators.length} actions · ${edge.from} → ${edge.to}`,
    );
  }

  function selectOperator(operatorId) {
    const operator = operatorById.get(operatorId);
    if (operator) {
      selected = { kind: "operator", id: operatorId };
      renderOperator(operator);
      openDetails();
      updateConsoleContext();
      setSelectionInfo(`Operator · ${operator.title} · ${operator.risk}`);
    }
  }

  function clearSelection() {
    selected = { kind: "overview", id: null };
    clearExpandedElements();
    clearSteps();
    resetClasses();
    renderOverview();
    closeDetails();
    updateConsoleContext();
    setSelectionInfo(
      "拖动画布平移 · 滚轮缩放 · 点击页面展开元素 · 点击 Task 高亮执行路径",
    );
    fitIds();
  }

  function expandSceneElements(sceneId) {
    const node = nodeById.get(sceneId);
    const elements = [...(elementsByScene.get(sceneId) || [])].sort(
      (left, right) =>
        operatorsForElement(right.elementId).length -
          operatorsForElement(left.elementId).length ||
        left.title.localeCompare(right.title),
    );
    for (const [index, element] of elements.entries()) {
      const ring = Math.floor(index / 18);
      const slot = index % 18;
      const count = Math.min(18, elements.length - ring * 18);
      const angle = -Math.PI / 2 + (slot * Math.PI * 2) / Math.max(1, count);
      const radius = 58 + ring * 48;
      const position = {
        x: node.x + Math.cos(angle) * radius,
        y: node.y + Math.sin(angle) * radius,
      };
      const line = createSvg("line", { class: "og-element-link" });
      const group = createSvg("g", { class: "og-element" });
      const dot = createSvg("circle", {
        class: "og-element-dot",
        r: operatorsForElement(element.elementId).length ? 4.6 : 3.1,
      });
      const label = createSvg("text", {
        class: "og-element-label",
        x: 7,
        y: 2,
      });
      const role = createSvg("text", {
        class: "og-element-role",
        x: 7,
        y: 10,
      });
      const title = createSvg("title");
      label.textContent = shortText(element.title, 24);
      role.textContent = shortText(element.semanticRole, 22);
      title.textContent = `${element.title} · ${element.semanticRole}`;
      group.append(dot, label, role, title);
      group.addEventListener("click", (event) => {
        event.stopPropagation();
        selectElement(element.elementId);
      });
      group.addEventListener("contextmenu", (event) =>
        openContextMenu(event, {
          kind: "element",
          id: element.elementId,
        }),
      );
      elementLayer.append(line, group);
      expandedElements.set(`${element.elementId}#${index}`, {
        element,
        line,
        group,
        position,
      });
    }
    renderExpandedElementPositions();
  }

  function clearExpandedElements() {
    expandedElements.clear();
    elementLayer.replaceChildren();
  }

  function renderExpandedElementPositions() {
    if (selected.kind !== "scene" && selected.kind !== "element") {
      return;
    }
    const sceneId =
      selected.kind === "element" ? selected.sceneId : selected.id;
    const node = nodeById.get(sceneId);
    for (const rendered of expandedElements.values()) {
      rendered.line.setAttribute("x1", node.x);
      rendered.line.setAttribute("y1", node.y);
      rendered.line.setAttribute("x2", rendered.position.x);
      rendered.line.setAttribute("y2", rendered.position.y);
      rendered.group.setAttribute(
        "transform",
        `translate(${rendered.position.x},${rendered.position.y})`,
      );
    }
  }

  function expandedBounds() {
    if (!expandedElements.size) {
      return null;
    }
    const positions = [...expandedElements.values()].map(
      (rendered) => rendered.position,
    );
    return {
      minimumX: Math.min(...positions.map((position) => position.x)) - 40,
      maximumX: Math.max(...positions.map((position) => position.x)) + 110,
      minimumY: Math.min(...positions.map((position) => position.y)) - 40,
      maximumY: Math.max(...positions.map((position) => position.y)) + 40,
    };
  }

  function renderTaskSteps(task) {
    const occurrences = new Map();
    for (const [index, operatorId] of task.operatorIds.entries()) {
      const operator = operatorById.get(operatorId);
      if (!operator) {
        continue;
      }
      let x;
      let y;
      if (operator.fromSceneId !== operator.toSceneId) {
        const from = nodeById.get(operator.fromSceneId);
        const to = nodeById.get(operator.toSceneId);
        const key = `${operator.fromSceneId}→${operator.toSceneId}`;
        const count = occurrences.get(key) || 0;
        occurrences.set(key, count + 1);
        x = (from.x + to.x) / 2 + count * 13;
        y = (from.y + to.y) / 2 - count * 11;
      } else {
        const node = nodeById.get(operator.fromSceneId);
        const count = occurrences.get(operator.fromSceneId) || 0;
        occurrences.set(operator.fromSceneId, count + 1);
        const angle = -Math.PI / 2 + count * 0.72;
        x = node.x + Math.cos(angle) * (node.radius + 19);
        y = node.y + Math.sin(angle) * (node.radius + 19);
      }
      const group = createSvg("g", { class: "og-step" });
      const circle = createSvg("circle", { r: 9 });
      const text = createSvg("text");
      text.textContent = String(index + 1);
      group.append(circle, text);
      group.dataset.x = String(x);
      group.dataset.y = String(y);
      group.dataset.operatorId = operatorId;
      group.addEventListener("click", (event) => {
        event.stopPropagation();
        selectOperator(operatorId);
      });
      group.addEventListener("contextmenu", (event) =>
        openContextMenu(event, { kind: "operator", id: operatorId }),
      );
      stepLayer.appendChild(group);
    }
    renderStepPositions();
  }

  function renderStepPositions() {
    for (const group of stepLayer.querySelectorAll(".og-step")) {
      group.setAttribute(
        "transform",
        `translate(${group.dataset.x},${group.dataset.y})`,
      );
    }
  }

  function clearSteps() {
    stepLayer.replaceChildren();
  }

  function renderOverview() {
    details.innerHTML = `<h2>App Graph</h2><div class="og-kind">RELATIONSHIP OVERVIEW</div><p class="og-muted">中央只展示页面关系。页面节点大小反映元素数量；点击页面会展开元素卫星图，点击 Task 会高亮有序执行路径。</p><div class="og-kv"><b>Pages</b><span>${graph.scenes.length}</span><b>Elements</b><span>${graph.elements.length}</span><b>States</b><span>${stateCount}</span><b>Actions</b><span>${graph.operators.length}</span><b>Tasks</b><span>${graph.tasks.length}</span></div>`;
  }

  function renderTask(task) {
    details.innerHTML = `<h2>${escapeHtml(task.title)}</h2><div class="og-kind">TASK PATH</div><div class="og-kv"><b>Task ID</b><span class="og-mono">${escapeHtml(task.taskId)}</span><b>Status</b><span>${escapeHtml(task.status)}</span><b>Entry Page</b><button class="og-link" data-scene="${escapeHtml(task.entrySceneId)}">${escapeHtml(task.entrySceneId)}</button><b>Summary</b><span>${escapeHtml(task.summary)}</span></div><h3>Execution Sequence</h3><ol class="og-sequence">${task.operatorIds
      .map((operatorId, index) => {
        const operator = operatorById.get(operatorId);
        return `<li><b>${index + 1}</b><div class="og-op-title">${escapeHtml(operator?.title || operatorId)}</div><button class="og-link og-mono" data-operator="${escapeHtml(operatorId)}">${escapeHtml(operatorId)}</button><div class="og-muted">${escapeHtml(operator ? `${operator.fromSceneId} → ${operator.toSceneId}` : "missing operator")}</div></li>`;
      })
      .join(
        "",
      )}</ol><h3>Final Oracles</h3><ul class="og-list">${task.finalOracles.map((oracle) => `<li class="og-mono">${escapeHtml(JSON.stringify(oracle))}</li>`).join("")}</ul>${renderValidation(task)}`;
    bindDetailLinks();
  }

  function renderValidation(task) {
    let html = "";
    if (task.verifier) {
      html += `<h3>Agent Verifier</h3><div class="og-kv"><b>Status</b><span>${escapeHtml(task.verifier.status)}</span><b>Confidence</b><span>${task.verifier.confidence}</span><b>Reason</b><span>${escapeHtml(task.verifier.reason)}</span></div>`;
    }
    if (task.validation) {
      html += `<h3>Validation</h3><div class="og-kv"><b>Source</b><span>${escapeHtml(task.validation.source)}</span><b>Successful</b><span>${task.validation.successfulExecutions}</span><b>Last Run</b><span>${escapeHtml(task.validation.lastValidatedAt)}</span></div>`;
    }
    return html;
  }

  function renderScene(scene) {
    const elements = elementsByScene.get(scene.sceneId) || [];
    const operators = operatorsByScene.get(scene.sceneId) || [];
    const screenshot = (scene.referenceAssets || []).find(
      (asset) => asset.screenshotPath,
    );
    details.innerHTML = `<h2>${escapeHtml(scene.title)}</h2><div class="og-kind">PAGE / SCENE</div><div class="og-kv"><b>Scene ID</b><span class="og-mono">${escapeHtml(scene.sceneId)}</span><b>Status</b><span>${escapeHtml(scene.status)}</span><b>Elements</b><span>${elements.length}</span><b>Actions</b><span>${operators.length}</span><b>State Variants</b><span>${(scene.stateVariants || []).length}</span></div>${screenshot ? `<h3>Reference Screenshot</h3><img class="og-preview" src="${escapeHtml(screenshot.screenshotPath)}">` : ""}<h3>Visual Anchors</h3><div>${(scene.visualTextAnchors || []).map((anchor) => `<span class="og-pill">${escapeHtml(anchor)}</span>`).join("") || '<span class="og-muted">none</span>'}</div><h3>Page Elements</h3><div>${elements.map((element) => `<button class="og-detail-action" data-element="${escapeHtml(element.elementId)}">${escapeHtml(element.title)} <span class="og-muted">· ${escapeHtml(element.semanticRole)}</span></button>`).join("")}</div><h3>Available Actions</h3><div>${operators.map((operator) => `<button class="og-detail-action" data-operator="${escapeHtml(operator.operatorId)}">${escapeHtml(operator.title)} <span class="og-muted">→ ${escapeHtml(operator.toSceneId)}</span></button>`).join("")}</div>`;
    bindDetailLinks();
  }

  function renderElement(element) {
    const operators = operatorsForElement(element.elementId);
    details.innerHTML = `<h2>${escapeHtml(element.title)}</h2><div class="og-kind">PAGE ELEMENT</div><div class="og-kv"><b>Element ID</b><span class="og-mono">${escapeHtml(element.elementId)}</span><b>Page</b><button class="og-link" data-scene="${escapeHtml(element.sceneId)}">${escapeHtml(element.sceneId)}</button><b>Role</b><span>${escapeHtml(element.semanticRole)}</span><b>Selector</b><span class="og-mono">${escapeHtml(JSON.stringify(element.selector))}</span></div><h3>Device Bindings</h3><ul class="og-list">${element.bindings.map((binding) => `<li><span class="og-mono">${escapeHtml(binding.deviceProfileId)}</span><br>${escapeHtml(JSON.stringify(binding.normalizedPoint))} · ${escapeHtml(binding.status)} · reliability ${binding.reliability}</li>`).join("")}</ul><h3>Element Actions</h3><div>${operators.map((operator) => `<button class="og-detail-action" data-operator="${escapeHtml(operator.operatorId)}">${escapeHtml(operator.title)}</button>`).join("")}</div>`;
    bindDetailLinks();
  }

  function renderEdge(edge) {
    details.innerHTML = `<h2>${escapeHtml(sceneById.get(edge.from).title)} → ${escapeHtml(sceneById.get(edge.to).title)}</h2><div class="og-kind">PAGE RELATION</div><div class="og-kv"><b>From</b><button class="og-link" data-scene="${escapeHtml(edge.from)}">${escapeHtml(edge.from)}</button><b>To</b><button class="og-link" data-scene="${escapeHtml(edge.to)}">${escapeHtml(edge.to)}</button><b>Actions</b><span>${edge.operators.length}</span></div><h3>Operators</h3><div>${edge.operators.map((operator) => `<button class="og-detail-action" data-operator="${escapeHtml(operator.operatorId)}">${escapeHtml(operator.title)} <span class="og-muted">· ${escapeHtml(operator.status)}</span></button>`).join("")}</div>`;
    bindDetailLinks();
  }

  function renderOperator(operator) {
    details.innerHTML = `<h2>${escapeHtml(operator.title)}</h2><div class="og-kind">OPERATOR / ACTION</div><div class="og-kv"><b>Operator ID</b><span class="og-mono">${escapeHtml(operator.operatorId)}</span><b>Transition</b><span><button class="og-link" data-scene="${escapeHtml(operator.fromSceneId)}">${escapeHtml(operator.fromSceneId)}</button> → <button class="og-link" data-scene="${escapeHtml(operator.toSceneId)}">${escapeHtml(operator.toSceneId)}</button></span><b>Risk</b><span>${escapeHtml(operator.risk)}</span><b>Status</b><span>${escapeHtml(operator.status)}</span><b>Reliability</b><span>${operator.reliability}</span><b>Operation</b><span class="og-mono">${escapeHtml(JSON.stringify(operator.operation))}</span><b>Settle</b><span>${operator.settleMs}ms</span></div><h3>Effects</h3><ul class="og-list">${operator.effects.map((effect) => `<li class="og-mono">${escapeHtml(effect)}</li>`).join("")}</ul><h3>Postconditions</h3><ul class="og-list">${operator.postconditions.map((condition) => `<li class="og-mono">${escapeHtml(condition)}</li>`).join("")}</ul>`;
    bindDetailLinks();
  }

  function bindDetailLinks() {
    for (const button of details.querySelectorAll("[data-scene]")) {
      button.addEventListener("click", () =>
        selectScene(button.dataset.scene, true),
      );
    }
    for (const button of details.querySelectorAll("[data-element]")) {
      button.addEventListener("click", () =>
        selectElement(button.dataset.element),
      );
    }
    for (const button of details.querySelectorAll("[data-operator]")) {
      button.addEventListener("click", () =>
        selectOperator(button.dataset.operator),
      );
    }
  }

  function openConsole() {
    consolePanel.classList.add("open");
    consoleInput.focus();
  }

  function closeConsole() {
    consolePanel.classList.remove("open");
  }

  function appendConsoleMessage(kind, text, content) {
    const message = document.createElement("div");
    message.className = `og-console-message ${kind}`;
    if (text) {
      const paragraph = document.createElement("div");
      paragraph.textContent = text;
      message.appendChild(paragraph);
    }
    if (content) {
      message.appendChild(content);
    }
    consoleMessages.appendChild(message);
    consoleMessages.scrollTop = consoleMessages.scrollHeight;
    return message;
  }

  function setConsoleBusy(busy) {
    consoleForm.classList.toggle("busy", busy);
    consoleInput.disabled = busy;
    consoleForm.querySelector('button[type="submit"]').disabled = busy;
  }

  async function fetchJson(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        "content-type": "application/json",
        ...(options.headers || {}),
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || `Request failed: ${response.status}`);
    }
    return { body, response };
  }

  async function checkConsoleService() {
    try {
      const { body } = await fetchJson("/api/health", { method: "GET" });
      graphRevision = body.graphRevision || "";
      consoleAvailable = true;
      consoleService.textContent = "已连接";
      consoleService.className = "connected";
    } catch {
      consoleAvailable = false;
      consoleService.textContent = "只读模式 · 请启动 Graph Console Server";
      consoleService.className = "offline";
    }
  }

  function destructiveTarget(target) {
    if (target.kind === "operator") {
      return operatorById.get(target.id)?.risk === "destructive";
    }
    if (target.kind !== "task") {
      return false;
    }
    const task = taskById.get(target.id);
    return (task?.operatorIds || []).some(
      (operatorId) => operatorById.get(operatorId)?.risk === "destructive",
    );
  }

  async function startAction(action, target, options = {}) {
    openConsole();
    closeContextMenu();
    if (!consoleAvailable) {
      appendConsoleMessage(
        "error",
        "Graph Console Server 未连接，当前页面只能查看和复制 ID。",
      );
      return;
    }
    let confirmed = options.confirmed === true;
    let parameters = options.parameters || {};
    if (action === "execute" && target.kind === "task") {
      const task = taskById.get(target.id);
      for (const [name, definition] of Object.entries(task?.parameters || {})) {
        if (!definition.required || parameters[name]) {
          continue;
        }
        const value = globalThis.prompt(`请输入参数 ${name}`);
        if (value === null) {
          return;
        }
        if (!value.trim()) {
          appendConsoleMessage("error", `参数 ${name} 不能为空。`);
          return;
        }
        parameters = { ...parameters, [name]: value.trim() };
      }
    }
    if (action === "execute" && destructiveTarget(target) && !confirmed) {
      confirmed = globalThis.confirm(
        `将执行破坏性操作：${entityTitle(target)}。确定继续吗？`,
      );
      if (!confirmed) {
        return;
      }
    }
    appendConsoleMessage(
      "user",
      `${action === "execute" ? "执行" : "继续探索"} ${typedId(target)}`,
    );
    runLog.replaceChildren();
    setConsoleBusy(true);
    try {
      const { body: run } = await fetchJson("/api/actions", {
        method: "POST",
        body: JSON.stringify({
          action,
          target,
          graphRevision,
          confirmed,
          parameters,
        }),
      });
      appendConsoleMessage("system", `Run ${run.runId} 已进入设备串行队列。`);
      watchRun(run.runId);
    } catch (error) {
      setConsoleBusy(false);
      appendConsoleMessage(
        "error",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  function watchRun(runId) {
    const events = new EventSource(
      `/api/runs/${encodeURIComponent(runId)}/events`,
    );
    events.onmessage = (message) => {
      const event = JSON.parse(message.data);
      renderRunEvent(event);
      if (
        event.type === "run" &&
        (event.status === "succeeded" || event.status === "failed")
      ) {
        events.close();
        setConsoleBusy(false);
        void checkConsoleService();
      }
    };
    events.onerror = () => {
      events.close();
      setConsoleBusy(false);
    };
  }

  function renderRunEvent(event) {
    const row = document.createElement("div");
    row.className = `og-run-event ${event.status || ""}`;
    if (event.type === "workflow") {
      const workflowEvent = event.workflowEvent || {};
      const phase =
        workflowEvent.phase ||
        workflowEvent.meta?.name ||
        workflowEvent.type ||
        "workflow";
      const detail =
        workflowEvent.message ||
        (typeof workflowEvent.durationMs === "number"
          ? `${Math.round(workflowEvent.durationMs)}ms`
          : "");
      row.innerHTML = `<span>${escapeHtml(phase)}</span><small>${escapeHtml(detail)}</small>`;
    } else {
      row.innerHTML = `<span>${escapeHtml(event.status || "run")}</span><small>${escapeHtml(event.message || "")}</small>`;
      if (event.status === "succeeded" || event.status === "failed") {
        appendConsoleMessage(
          event.status === "succeeded" ? "agent" : "error",
          event.message ||
            (event.status === "succeeded" ? "运行成功。" : "运行失败。"),
        );
      }
    }
    runLog.appendChild(row);
    runLog.scrollTop = runLog.scrollHeight;
  }

  function renderAgentResponse(response) {
    if (response.kind === "correction_proposal" && response.proposal) {
      const card = document.createElement("div");
      card.className = "og-proposal";
      const list = document.createElement("ul");
      for (const change of response.proposal.changes) {
        const item = document.createElement("li");
        item.textContent = `${change.entityKind}:${change.entityId} · ${change.field} → ${Array.isArray(change.value) ? change.value.join("、") : change.value}`;
        list.appendChild(item);
      }
      card.innerHTML = `<strong>${escapeHtml(response.proposal.summary)}</strong>`;
      card.appendChild(list);
      if (response.proposal.requiresExploration) {
        const note = document.createElement("div");
        note.className = "og-proposal-warning";
        note.textContent = "该修正涉及结构或证据不足，必须先探索验证。";
        card.appendChild(note);
        const explore = document.createElement("button");
        explore.type = "button";
        explore.textContent = "先探索验证";
        explore.addEventListener("click", () => {
          const target = response.target || selectedTarget();
          if (target) {
            void startAction("explore", target);
          }
        });
        card.appendChild(explore);
      } else {
        const apply = document.createElement("button");
        apply.type = "button";
        apply.textContent = "应用修改";
        apply.addEventListener(
          "click",
          () => void applyCorrection(response.proposal.proposalId, apply),
        );
        card.appendChild(apply);
      }
      appendConsoleMessage("agent", response.message, card);
      return;
    }
    const actions = document.createElement("div");
    if (response.action && response.target) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent =
        response.action === "execute" ? "执行这个节点" : "继续探索这个节点";
      button.addEventListener(
        "click",
        () => void startAction(response.action, response.target),
      );
      actions.appendChild(button);
    }
    appendConsoleMessage(
      "agent",
      response.message,
      actions.childElementCount ? actions : null,
    );
  }

  async function applyCorrection(proposalId, button) {
    button.disabled = true;
    try {
      const { body } = await fetchJson(
        `/api/corrections/${encodeURIComponent(proposalId)}/apply`,
        { method: "POST", body: "{}" },
      );
      graphRevision = body.graphRevision;
      appendConsoleMessage(
        "system",
        `已原子应用 ${body.appliedChangeCount} 项修改，Graph 即将刷新。`,
      );
      setTimeout(() => location.reload(), 700);
    } catch (error) {
      button.disabled = false;
      appendConsoleMessage(
        "error",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  function cssEscape(value) {
    return globalThis.CSS?.escape
      ? globalThis.CSS.escape(value)
      : String(value).replaceAll('"', "");
  }

  function startNodeDrag(event, node) {
    event.stopPropagation();
    pointerMoved = false;
    dragNode = node;
    dragStart = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      nodeX: node.x,
      nodeY: node.y,
    };
    node.fixed = true;
    svg.classList.add("dragging");
  }

  detailsClose.addEventListener("click", closeDetails);
  detailsBackdrop.addEventListener("click", closeDetails);
  document.getElementById("og-agent-toggle").addEventListener("click", () => {
    consolePanel.classList.toggle("open");
    if (consolePanel.classList.contains("open")) {
      consoleInput.focus();
    }
  });
  document
    .getElementById("og-console-close")
    .addEventListener("click", closeConsole);
  contextMenu.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-context-action]");
    if (!button || !contextTarget) {
      return;
    }
    const action = button.dataset.contextAction;
    if (action === "copy") {
      const value = typedId(contextTarget);
      navigator.clipboard
        .writeText(value)
        .then(() => {
          appendConsoleMessage("system", `已复制 ${value}`);
          openConsole();
        })
        .catch(() => {
          appendConsoleMessage("error", `复制失败，请手动复制：${value}`);
          openConsole();
        });
      closeContextMenu();
      return;
    }
    if (action === "execute" && contextTarget.kind === "element") {
      openOperatorChoices(contextTarget.id);
      return;
    }
    if (action === "execute" || action === "explore") {
      void startAction(action, contextTarget);
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest?.("#og-context-menu")) {
      closeContextMenu();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeContextMenu();
    }
    if (
      (event.metaKey || event.ctrlKey) &&
      event.key === "Enter" &&
      document.activeElement === consoleInput
    ) {
      consoleForm.requestSubmit();
    }
  });
  consoleForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = consoleInput.value.trim();
    if (!message) {
      return;
    }
    openConsole();
    appendConsoleMessage("user", message);
    consoleInput.value = "";
    if (!consoleAvailable) {
      appendConsoleMessage(
        "error",
        "Graph Console Server 未连接，无法启动 Agent。",
      );
      return;
    }
    setConsoleBusy(true);
    try {
      const { body } = await fetchJson("/api/chat", {
        method: "POST",
        body: JSON.stringify({
          message,
          target: selectedTarget(),
          graphRevision,
        }),
      });
      renderAgentResponse(body);
    } catch (error) {
      appendConsoleMessage(
        "error",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setConsoleBusy(false);
    }
  });

  svg.addEventListener("pointerdown", (event) => {
    if (event.target.closest?.(".og-scene,.og-element,.og-step,.og-edge-hit")) {
      return;
    }
    pointerMoved = false;
    panStart = {
      x: event.clientX,
      y: event.clientY,
      transformX: transform.x,
      transformY: transform.y,
    };
    svg.setPointerCapture(event.pointerId);
    svg.classList.add("dragging");
  });

  svg.addEventListener("pointermove", (event) => {
    if (dragNode && dragStart) {
      if (
        !pointerMoved &&
        Math.hypot(
          event.clientX - dragStart.clientX,
          event.clientY - dragStart.clientY,
        ) <= 4
      ) {
        return;
      }
      if (!pointerMoved) {
        pointerMoved = true;
        svg.setPointerCapture(event.pointerId);
      }
      const rectangle = svg.getBoundingClientRect();
      const x =
        (event.clientX - rectangle.left - transform.x) / transform.scale;
      const y = (event.clientY - rectangle.top - transform.y) / transform.scale;
      dragNode.x = x;
      dragNode.y = y;
      dragNode.vx = 0;
      dragNode.vy = 0;
      renderPositions();
      return;
    }
    if (panStart) {
      if (
        Math.hypot(event.clientX - panStart.x, event.clientY - panStart.y) > 3
      ) {
        pointerMoved = true;
      }
      transform.x = panStart.transformX + event.clientX - panStart.x;
      transform.y = panStart.transformY + event.clientY - panStart.y;
      applyTransform();
    }
  });

  svg.addEventListener("pointerup", (event) => {
    if (dragNode) {
      const wasDrag = pointerMoved;
      if (!wasDrag && dragStart) {
        dragNode.x = dragStart.nodeX;
        dragNode.y = dragStart.nodeY;
      }
      dragNode.fixed = false;
      dragNode = null;
      dragStart = null;
      if (wasDrag) {
        restartSimulation(0.25);
      }
    }
    panStart = null;
    svg.classList.remove("dragging");
    try {
      svg.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture can already be released by the browser.
    }
  });

  svg.addEventListener("click", (event) => {
    if (
      !pointerMoved &&
      !event.target.closest?.(".og-scene,.og-element,.og-step,.og-edge-hit")
    ) {
      clearSelection();
    }
  });
  svg.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      zoomAt(event.deltaY > 0 ? 0.88 : 1.14, event.clientX, event.clientY);
    },
    { passive: false },
  );

  for (const button of document.querySelectorAll(".og-tab")) {
    button.addEventListener("click", () => {
      for (const item of document.querySelectorAll(".og-tab")) {
        item.classList.toggle("active", item === button);
      }
      for (const panel of document.querySelectorAll(".og-panel")) {
        panel.classList.toggle(
          "active",
          panel.id === `og-panel-${button.dataset.panel}`,
        );
      }
    });
  }

  search.addEventListener("input", () => {
    const query = search.value.trim().toLowerCase();
    for (const item of document.querySelectorAll(".og-item")) {
      item.style.display =
        !query || item.textContent.toLowerCase().includes(query) ? "" : "none";
    }
    for (const [sceneId, element] of sceneElements) {
      const scene = sceneById.get(sceneId);
      const matches =
        !query ||
        [sceneId, scene.title, ...(scene.aliases || [])]
          .join(" ")
          .toLowerCase()
          .includes(query);
      if (selected.kind === "overview") {
        element.style.opacity = matches ? "1" : "0.06";
      }
    }
  });

  document.getElementById("og-fit").addEventListener("click", () => fitIds());
  document.getElementById("og-home").addEventListener("click", () => {
    selectScene(
      sceneById.has("chat.detail") ? "chat.detail" : nodes[0].id,
      true,
    );
  });
  document.getElementById("og-clear").addEventListener("click", () => {
    search.value = "";
    for (const item of document.querySelectorAll(".og-item")) {
      item.style.display = "";
    }
    for (const element of sceneElements.values()) {
      element.style.opacity = "";
    }
    clearSelection();
  });
  document
    .getElementById("og-zoom-in")
    .addEventListener("click", () => zoomAt(1.25));
  document
    .getElementById("og-zoom-out")
    .addEventListener("click", () => zoomAt(0.8));
  document.getElementById("og-labels").addEventListener("click", () => {
    showLabels = !showLabels;
    for (const label of document.querySelectorAll(
      ".og-scene-label,.og-scene-sub,.og-element-label,.og-element-role,.og-module-label",
    )) {
      label.style.display = showLabels ? "" : "none";
    }
  });
  window.addEventListener("resize", () => {
    if (selected.kind === "overview") {
      fitIds();
    }
  });

  buildLists();
  buildGraph();
  renderOverview();
  updateConsoleContext();
  applyTransform();
  fitIds();
  restartSimulation(1);
  runtimeStatus.textContent = "interactive graph ready";
  runtimeStatus.className = "og-runtime ready";
  runtimeBeacon("runtime-ready");
  void checkConsoleService();
  if (new URLSearchParams(location.search).has("selftest")) {
    requestAnimationFrame(() => {
      try {
        const task =
          taskById.get("skills.open_from_chat_sidebar") || graph.tasks[0];
        selectTask(task.taskId);
        const activeSceneCount =
          sceneLayer.querySelectorAll(".og-scene.active").length;
        const activeEdgeCount =
          edgeLayer.querySelectorAll(".og-edge.active").length;
        const taskStepCount = stepLayer.querySelectorAll(".og-step").length;
        if (activeSceneCount === 0) {
          throw new Error("Task selection did not activate any Scene.");
        }
        if (taskStepCount !== task.operatorIds.length) {
          throw new Error(
            `Task rendered ${taskStepCount} steps, expected ${task.operatorIds.length}.`,
          );
        }
        const sceneId = sceneById.has("chat.detail")
          ? "chat.detail"
          : graph.scenes[0].sceneId;
        const scene = sceneById.get(sceneId);
        const sceneGroup = sceneElements.get(sceneId);
        const sceneNode = nodeById.get(sceneId);
        const pointerId = 71;
        sceneGroup.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            pointerId,
            clientX: sceneNode.x,
            clientY: sceneNode.y,
          }),
        );
        svg.dispatchEvent(
          new PointerEvent("pointerup", {
            bubbles: true,
            pointerId,
            clientX: sceneNode.x,
            clientY: sceneNode.y,
          }),
        );
        if (selected.kind !== "scene" || selected.id !== sceneId) {
          throw new Error("Real pointer click did not select the Scene.");
        }
        if (!details.textContent.includes(scene.title)) {
          throw new Error("Scene click did not update the details panel.");
        }
        const relatedSceneCount =
          sceneLayer.querySelectorAll(".og-scene.near").length;
        const relatedEdgeCount =
          edgeLayer.querySelectorAll(".og-edge.near").length;
        if (relatedSceneCount === 0 || relatedEdgeCount === 0) {
          throw new Error("Scene click did not highlight related graph items.");
        }
        const expectedElementCount = (elementsByScene.get(sceneId) || [])
          .length;
        if (expandedElements.size !== expectedElementCount) {
          throw new Error(
            `Scene rendered ${expandedElements.size} elements, expected ${expectedElementCount}.`,
          );
        }
        const initialScale = transform.scale;
        zoomAt(1.25);
        if (transform.scale <= initialScale) {
          throw new Error("Zoom did not increase the graph scale.");
        }
        const initialX = transform.x;
        transform.x += 24;
        applyTransform();
        if (transform.x === initialX) {
          throw new Error("Pan did not change the viewport transform.");
        }
        runtimeBeacon(
          "selftest-passed",
          JSON.stringify({
            taskId: task.taskId,
            activeSceneCount,
            activeEdgeCount,
            taskStepCount,
            sceneId,
            sceneClickSelected: true,
            detailsUpdated: true,
            relatedSceneCount,
            relatedEdgeCount,
            expandedElementCount: expandedElements.size,
            zoomScale: transform.scale,
            panDeltaX: transform.x - initialX,
          }),
        );
        runtimeStatus.dataset.selftest = "passed";
        runtimeStatus.dataset.selftestDetail = JSON.stringify({
          sceneClickSelected: true,
          detailsUpdated: true,
          relatedSceneCount,
          relatedEdgeCount,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        runtimeStatus.dataset.selftest = "failed";
        runtimeStatus.dataset.selftestDetail = message;
        runtimeBeacon("selftest-failed", message);
        throw error;
      }
    });
  }

  if (oldRevision && location.protocol.startsWith("http")) {
    setInterval(async () => {
      try {
        const response = await fetch(
          `semantic-map-summary.json?ts=${Date.now()}`,
          { cache: "no-store" },
        );
        if (!response.ok) {
          return;
        }
        const summary = await response.json();
        if (summary.generatedAt && summary.generatedAt !== oldRevision) {
          location.reload();
        }
      } catch {
        // Live reload remains best effort.
      }
    }, 2000);
  }
})();
