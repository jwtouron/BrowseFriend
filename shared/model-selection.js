export function selectModel(models, preference) {
  if (!Array.isArray(models) || !models.length) return null;
  if (preference === "automatic") return models[0];
  return models.find((model) => model.slug === preference) || models[0];
}

export function automaticModelLabel(models) {
  const model = selectModel(models, "automatic");
  return model?.displayName ? `Automatic (${model.displayName})` : "Automatic";
}
