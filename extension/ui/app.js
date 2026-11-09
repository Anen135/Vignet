const $ = (id) => document.getElementById(id);
let dashboard = { assets: [], instances: [], contexts: [], media: [] };
let pendingPackage;
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function notice(text, bad = false) {
  $("notice").textContent = text;
  $("notice").className = bad ? "error" : "";
}
async function request(command, args = {}) {
  const result = await chrome.runtime.sendMessage({
    type: "VIGNET_UI",
    command,
    args,
  });
  if (!result?.ok) {
    const err = result?.error;
    throw new Error(
      `${err?.code || "ERROR"}: ${err?.message || err || "Расширение не ответило"}`,
    );
  }
  return result;
}
function button(text, action) {
  const b = node("button", text);
  b.type = "button";
  b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      await action();
    } catch (error) {
      notice(error.message, true);
    } finally {
      b.disabled = false;
    }
  });
  return b;
}
function formFor(schema = {}, values = {}) {
  const form = node("form");
  const readers = [];
  for (const [key, property] of Object.entries(schema.properties || {})) {
    const label = node("label", property.title || key);
    const value = values[key] ?? property.default;
    let input;
    if (property.enum) {
      input = node("select");
      for (const choice of property.enum) {
        const opt = node("option", String(choice));
        opt.value = JSON.stringify(choice);
        input.append(opt);
      }
      if (value !== undefined) input.value = JSON.stringify(value);
      readers.push(() => [key, JSON.parse(input.value)]);
    } else if (property.type === "boolean") {
      input = node("input");
      input.type = "checkbox";
      input.checked = Boolean(value);
      readers.push(() => [key, input.checked]);
    } else if (property.type === "object" || property.type === "array") {
      input = node("textarea");
      input.value = JSON.stringify(
        value ?? (property.type === "array" ? [] : {}),
      );
      readers.push(() => [key, JSON.parse(input.value)]);
    } else {
      input = node("input");
      input.type = ["number", "integer"].includes(property.type)
        ? "number"
        : "text";
      if (property.minimum !== undefined) input.min = property.minimum;
      if (property.maximum !== undefined) input.max = property.maximum;
      input.step = property.type === "integer" ? "1" : "any";
      if (value !== undefined) input.value = String(value);
      if (schema.required?.includes(key)) input.required = true;
      readers.push(() => [
        key,
        input.value === ""
          ? undefined
          : input.type === "number"
            ? Number(input.value)
            : input.value,
      ]);
    }
    label.append(input);
    if (property.description) label.append(node("small", property.description));
    form.append(label);
  }
  form.addEventListener("submit", (e) => e.preventDefault());
  form.read = () => {
    if (!form.reportValidity())
      throw new Error("Проверьте значения параметров");
    return Object.fromEntries(
      readers.map((read) => read()).filter(([, value]) => value !== undefined),
    );
  };
  return form;
}
function selectedTarget() {
  if (!$("target").value) throw new Error("Выберите вкладку ChatGPT");
  return { tabId: Number($("target").value) };
}
async function mutate(command, args) {
  await request(command, args);
  await refresh();
}
function showAssets() {
  $("assets").replaceChildren();
  for (const record of dashboard.assets) {
    const m = record.manifest;
    const card = node("article", undefined, "card");
    card.append(
      node("h3", m.name),
      node("p", m.description),
      node(
        "p",
        `${m.id} · ${m.version} · ${record.enabled ? "Включён" : "Выключен"}`,
        "metadata",
      ),
    );
    card.append(
      node(
        "p",
        `Источник: ${record.source || (m.id === "builtin.vignette" ? "Встроенный" : "Локальный пакет")} · Разрешения: ${(m.permissions || []).join(", ") || "нет"}`,
        "metadata",
      ),
    );
    const actions = node("div", undefined, "actions");
    if (m.id !== "builtin.vignette")
      actions.append(
        button(record.enabled ? "Выключить" : "Включить", () =>
          mutate("enable_asset", { assetId: m.id, enabled: !record.enabled }),
        ),
      );
    if (m.id !== "builtin.vignette") {
      actions.append(
        button("Экспорт", async () => {
          const result = await request("export_asset", { assetId: m.id });
          const url = URL.createObjectURL(
            new Blob([new Uint8Array(result.bytes)], {
              type: "application/zip",
            }),
          );
          const link = node("a");
          link.href = url;
          link.download = result.filename || `${m.id}.vignet`;
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 2000);
        }),
      );
      actions.append(
        button("Удалить", async () => {
          if (confirm(`Удалить ${m.name} и его конфигурации?`))
            await mutate("delete_asset", { assetId: m.id });
        }),
      );
    }
    card.append(actions);
    const actionLabel = node("label", "Действие");
    const select = node("select");
    for (const [name, descriptor] of Object.entries(m.actions || {})) {
      const opt = node("option", `${name} — ${descriptor.description}`);
      opt.value = name;
      select.append(opt);
    }
    if (m.actions?.start) select.value = "start";
    actionLabel.append(select);
    card.append(actionLabel);
    let paramsForm;
    const holder = node("div");
    const setForm = () => {
      paramsForm = formFor(
        m.actions[select.value]?.parameters || m.settingsSchema,
      );
      holder.replaceChildren(paramsForm);
    };
    select.addEventListener("change", setForm);
    setForm();
    card.append(holder);
    card.append(
      button("Выполнить", () =>
        mutate("run_asset", {
          assetId: m.id,
          action: select.value,
          parameters: paramsForm.read(),
          scope: $("scope").value,
          target: selectedTarget(),
        }),
      ),
    );
    $("assets").append(card);
  }
}
function showInstances() {
  $("instances").replaceChildren();
  if (!dashboard.instances.length)
    $("instances").append(node("p", "Нет сохранённых экземпляров"));
  for (const instance of dashboard.instances) {
    const row = node("article", undefined, "instance");
    row.append(
      node("h3", instance.assetId),
      node(
        "p",
        `${instance.instanceId} · ${instance.status || "unknown"} · ${instance.scope} · ${instance.contextKey || ""}`,
        "metadata",
      ),
    );
    if (instance.error)
      row.append(node("pre", JSON.stringify(instance.error, null, 2)));
    const asset = dashboard.assets.find(
      (r) => r.manifest.id === instance.assetId,
    );
    const form = formFor(
      asset?.manifest.settingsSchema ||
        asset?.manifest.actions?.start?.parameters,
      instance.parameters,
    );
    row.append(form);
    const actions = node("div", undefined, "actions");
    actions.append(
      button("Обновить", () =>
        mutate("update_asset_instance", {
          instanceId: instance.instanceId,
          parameters: form.read(),
        }),
      ),
    );
    actions.append(
      button("Остановить", () =>
        mutate("stop_asset", { instanceId: instance.instanceId }),
      ),
    );
    actions.append(
      button("Перезапустить", async () => {
        const parameters = form.read();
        await request("stop_asset", { instanceId: instance.instanceId });
        await mutate("run_asset", {
          assetId: instance.assetId,
          parameters,
          scope: instance.scope === "chat" ? "current_chat" : instance.scope,
          target: instance.tabId ? { tabId: instance.tabId } : selectedTarget(),
        });
      }),
    );
    row.append(actions);
    $("instances").append(row);
  }
}
async function refresh() {
  dashboard = await request("dashboard");
  dashboard.assets ||= [];
  dashboard.instances ||= [];
  dashboard.contexts ||= [];
  dashboard.media ||= [];
  const selected = $("target").value;
  $("target").replaceChildren();
  const placeholder = node("option", "Выберите вкладку…");
  placeholder.value = "";
  $("target").append(placeholder);
  for (const context of dashboard.contexts) {
    const opt = node(
      "option",
      `Вкладка ${context.tabId}: ${context.chatId || context.contextKey || context.url || "новый чат"}`,
    );
    opt.value = context.tabId;
    $("target").append(opt);
  }
  if (dashboard.contexts.some((context) => String(context.tabId) === selected))
    $("target").value = selected;
  else if (dashboard.contexts.length === 1)
    $("target").value = dashboard.contexts[0].tabId;
  showAssets();
  showInstances();
  $("media").replaceChildren();
  $("media-summary").textContent =
    `${dashboard.media.length} физических ресурсов · ${dashboard.media.reduce((n, m) => n + (m.size || 0), 0).toLocaleString()} байт`;
  for (const media of dashboard.media)
    $("media").append(
      node(
        "div",
        `${media.hash} · ${media.mime} · ${media.size} байт · связи: ${JSON.stringify(media.owners || media.references || media.refs || [])}`,
        "media-row",
      ),
    );
  $("diagnostics").textContent = JSON.stringify(
    dashboard.diagnostics || {},
    null,
    2,
  );
  const endpoint =
    dashboard.diagnostics?.endpoint || dashboard.diagnostics?.config?.endpoint;
  if (endpoint && document.activeElement !== $("endpoint"))
    $("endpoint").value = endpoint;
}
async function inspect(file) {
  pendingPackage = undefined;
  $("review").hidden = true;
  if (!file || !file.name.endsWith(".vignet"))
    throw new Error("Выберите .vignet ZIP-пакет");
  if (file.size > 16 * 1024 * 1024) throw new Error("Архив больше 16 MiB");
  const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
  const response = await request("inspect_package", { bytes });
  const review = response.review || response;
  const m = review.manifest;
  pendingPackage = { bytes, manifest: m };
  const area = $("review");
  area.replaceChildren();
  area.hidden = false;
  area.append(
    node("h3", `${m.name} ${m.version}`),
    node("p", m.description),
    node(
      "p",
      `Автор: ${m.author || "не указан"} · Лицензия: ${m.license || "не указана"} · ${review.totalSize} байт · ${review.fileCount ?? "?"} файлов`,
    ),
  );
  area.append(
    node(
      "pre",
      Object.entries(m.actions)
        .map(([name, action]) => `${name}: ${action.description}`)
        .join("\n"),
    ),
  );
  const consent = [];
  for (const permission of m.permissions || []) {
    const label = node("label");
    const checkbox = node("input");
    checkbox.type = "checkbox";
    label.append(checkbox, document.createTextNode(`Разрешаю ${permission}`));
    area.append(label);
    consent.push([permission, checkbox]);
  }
  if (m.entry || m.scripts?.length)
    area.append(
      node(
        "p",
        "Внимание: пользовательский JavaScript с доступом к DOM может читать беседу. Изолированный мир не обеспечивает конфиденциальность DOM. Разрешайте только доверенные пакеты.",
      ),
    );
  area.append(
    node(
      "p",
      `Очистка: ${m.execution?.cleanupGuarantee || "не указана"}. Перезагрузка при остановке: ${m.execution?.requiresReloadOnStop ? "может потребоваться" : "не заявлена"}.`,
    ),
  );
  const label = node("label");
  const confirmInput = node("input");
  confirmInput.type = "checkbox";
  label.append(
    confirmInput,
    document.createTextNode(
      "Подтверждаю установку/обновление этой версии и перечисленные риски. Пакет не запускается автоматически.",
    ),
  );
  area.append(label);
  const installed = dashboard.assets.some((r) => r.manifest.id === m.id);
  area.append(
    button(
      installed ? "Подтвердить обновление" : "Подтвердить установку",
      async () => {
        if (
          !confirmInput.checked ||
          consent.some(([, checkbox]) => !checkbox.checked)
        )
          throw new Error("Подтвердите установку и все необходимые разрешения");
        await mutate("install_package", {
          bytes: pendingPackage.bytes,
          confirmed: true,
          grantedPermissions: consent.map(([permission]) => permission),
          replace: installed,
        });
        pendingPackage = undefined;
        area.hidden = true;
        $("file").value = "";
        notice("Пакет установлен. Для запуска выберите контекст и действие.");
      },
    ),
  );
  area.append(
    button("Отмена", () => {
      pendingPackage = undefined;
      area.hidden = true;
    }),
  );
}
$("refresh").addEventListener("click", () =>
  refresh().catch((e) => notice(e.message, true)),
);
$("file").addEventListener("change", () =>
  inspect($("file").files[0]).catch((e) => notice(e.message, true)),
);
for (const name of ["dragenter", "dragover"])
  $("drop").addEventListener(name, (e) => {
    e.preventDefault();
    $("drop").classList.add("over");
  });
for (const name of ["dragleave", "drop"])
  $("drop").addEventListener(name, (e) => {
    e.preventDefault();
    $("drop").classList.remove("over");
  });
$("drop").addEventListener("drop", (e) =>
  inspect(e.dataTransfer.files[0]).catch((error) =>
    notice(error.message, true),
  ),
);
$("gc").addEventListener("click", () =>
  mutate("gc_media", {}).catch((e) => notice(e.message, true)),
);
$("connection").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const args = { endpoint: $("endpoint").value };
    if ($("token").value) args.deviceToken = $("token").value;
    await mutate("settings", args);
    $("token").value = "";
    notice("Настройки подключения сохранены.");
  } catch (error) {
    notice(error.message, true);
  }
});
refresh().catch((error) => notice(error.message, true));
