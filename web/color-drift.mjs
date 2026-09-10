// Shared with the ballpark and the paper backgrounds: an eight-second RGB LFO at 1×.
export const colorDriftGLSL = `
vec3 driftColor(vec3 base, vec2 uv, vec2 pixel, vec2 shapePhase, float time, float amplitude, float grouping, float shapeMode) {
  float grainPhase = fract(sin(dot(floor(pixel), vec2(12.9898,78.233))) * 43758.5453);
  float groupedPhase = mix(shapePhase.r, shapePhase.g, smoothstep(.4, 1.0, grouping));
  float shapeDrift = mix(grainPhase * 6.2831853, groupedPhase, smoothstep(0.0, .4, grouping));
  vec2 blob = uv * mix(180.0, 5.0, sqrt(grouping));
  float blobPhase = (sin(blob.x + sin(blob.y * .73)) + sin(blob.y * 1.17 + cos(blob.x * .61))) * 3.14159265;
  float acidDrift = mix(grainPhase * 6.2831853, blobPhase, smoothstep(0.0, .15, grouping));
  float phase = mix(acidDrift, shapeDrift, shapeMode);
  vec3 drift = sin(vec3(phase) + vec3(0., .7, 1.4) + time * .78539816) * (amplitude / 255.0);
  return clamp(base + drift, 0., 1.);
}`;
