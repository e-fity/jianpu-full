# Visual review and final integration corrections

Actual smoke render succeeded: 60 frames at 360x640, 2-second MP4 with audio. 60 tests passed at review time. Reviewer inspected frame 1 and frame 37 at the first landing. Current visual result is not acceptable yet: overly close camera, ball and active board pushed to lower right, nearly white low-contrast scene, white-clipped emission rather than colored glow. Reference has a small pearl ball, multiple suspended boards, neutral gray background and saturated cyan/yellow/orange contact light.

Make a focused final visual correction, preserve fixed timing and passing tests:
1. Camera: wider oblique side view with 4-6 boards readable and ball around center, entire ball visible through hop. Suggested orthographic camera scale 7.8-8.4 (portrait), offset approx (-3,-6,5.5), target lookahead around (0.6,0,0). Avoid distant horizon line and giant foreground board. Use track for smooth follow.
2. Neutral medium-gray floor/world, substantially less ambient and sun energy so shadows and color have contrast. Idle boards dark charcoal/blue or muted teal. Use saturated hue palette (cyan, green, yellow, orange, magenta by note/event), moderate emission rather than overexposing to white. Subtle colored point light near current landing can give the floor a colored halo (EEVEE material emission alone won't illuminate it). Ball remains glossy pearl, not a glowing white disk. Star bursts visible but sparse.
3. Replace legacy Glare socket property assignment if it causes RNA_float_set warning; use Blender 4.5 supported node inputs verified through introspection, avoid ignored errors.
4. Ground coverage currently uses fixed 500 units, rejecting longer valid songs; size the ground from board extents plus margin. Add test with >600 notes, no arbitrary valid-song length cap.
5. README: add Chinese quickstart with actual D:/apps/Blender path and clearly distinguish tested preview from untested full-song render. Keep synthesis/lyrics limitations honest. Do not claim finished reference matching.

Only edit ball3d. Reviewer will render a 12-second sample and small batch after fixes. Do not execute shell commands, do not edit previous review documents. No web UI, extra architecture, or new libraries needed.
