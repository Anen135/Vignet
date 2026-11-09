import * as cssTree from "css-tree";

export function resolveResourcePath(reference, stylesheetPath) {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(reference)) {
    if (reference.startsWith("vignet-media://"))
      return reference.slice("vignet-media://".length);
    throw Object.assign(
      new Error(`External resource forbidden: ${reference}`),
      { code: "INVALID_RESOURCE" },
    );
  }
  const parts = stylesheetPath.split("/").slice(0, -1);
  for (const segment of reference.split("/")) {
    if (segment === "..") {
      if (!parts.length) throw new Error("Resource escapes package");
      parts.pop();
    } else if (segment !== "." && segment) parts.push(segment);
  }
  return parts.join("/");
}

export async function rewriteCss(css, path, resolve) {
  const ast = cssTree.parse(css, {
    parseCustomProperty: true,
    onParseError(error) {
      throw error;
    },
  });
  const nodes = [];
  cssTree.walk(ast, (node) => {
    if (node.type === "Atrule" && /^(import|namespace)$/i.test(node.name))
      throw new Error("External CSS imports forbidden");
    if (node.type === "Url") nodes.push(node);
  });
  for (const node of nodes)
    node.value = await resolve(resolveResourcePath(node.value, path));
  return cssTree.generate(ast);
}

// The actual Blob URLs are created in the document world where they are consumed.
export async function prepareStyles(asset, store) {
  const styles = [];
  for (const path of asset.manifest.styles || []) {
    const file = asset.files.find((entry) => entry.path === path);
    if (!file) throw new Error(`Missing stylesheet ${path}`);
    const blob = await store.getMedia(file.hash);
    styles.push(
      await rewriteCss(await blob.text(), path, (resourcePath) => {
        if (!asset.files.some((entry) => entry.path === resourcePath))
          throw new Error(`Missing resource ${resourcePath}`);
        return `vignet-media://${resourcePath}`;
      }),
    );
  }
  return styles;
}
