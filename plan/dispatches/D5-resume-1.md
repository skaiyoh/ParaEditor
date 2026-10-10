# D5 resume: the quantize shader does not compile in Chrome

In the lead's run every scenario failed at import because the renderer's program creation threw and the import was refused; the status line read:

```
The render shader failed: ERROR: 0:4: 'o' : when EXT_blend_func_extended extension is not enabled, must explicitly specify all locations when using multiple fragment outputs
```

GLSL ES 3.0 requires `layout(location = N)` on every fragment output when a shader has more than one.
Your quantize shader (and any other pass you gave two outputs, such as the cells reduction) declares `out vec4 o;` through the shared header without a location.
Fix: give every multi-output fragment shader explicit locations (`layout(location = 0) out vec4 o; layout(location = 1) out vec4 variant;`), keeping the shared header for single-output passes (or add a location there too, which is harmless), and make sure the draw-buffer order of the framebuffer matches.
Also check the two cells shaders and the reduce pass for the same rule, and that `gl.drawBuffers` is set for the quantize framebuffer when the variant attachment is attached.
Change nothing else.
Run `npm run typecheck`, `npm run build`, and the node-test command from `AGENTS.md`; add a "Resume 1" line to the Return; and stop.
