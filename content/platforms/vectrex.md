# Vectrex Standards

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [main.md](../../main.md) | [PROJECT.md](../../PROJECT.md) | [c.md](../languages/c.md)

**Stack**: Motorola 6809 @ 1.5 MHz; BIOS ROM + cartridge ROM; ~1 KB system RAM; vector CRT via VIA 6522; AY-3-8912 (3 voices); 50 Hz frame via `Wait_Recal` / T2. Prefer **VectreC (CMOC + lwtools + Vectrex stdlib)** for C, or classic 6809 asm against BIOS.

## Hardware Reference

- **CPU**: Motorola 6809E, 1.5 MHz
- **RAM**: 1 KB (BIOS + game share; treat as precious)
- **ROM**: Cartridge (typical homebrew 8–32 KB; plan for size early)
- **Display**: Vector CRT — no framebuffer; every line costs beam time
- **I/O**: VIA 6522 (DAC, integrators, timers, joystick mux)
- **Audio**: General Instrument AY-3-8912 (3 square / noise channels)
- **Input**: Analog joystick + 4 buttons per controller
- **Frame rate**: 50 Hz refresh (European TV timing); budget ~20 ms/frame
- **Coordinate space**: Signed 8-bit screen coords (≈ −128…127); keep playfield inside a safe margin (~±115)

## Toolchain

### Preferred (C)
- ! Use [VectreC](https://github.com/rogerboesch/vectreC) (CMOC + lwtools + `vectrex/*` stdlib) for new C games
- ! Pin toolchain path via `config.env` / `VECTREC` (do not hardcode machine-local absolute paths in source)
- ! Produce a raw `.bin` ROM suitable for Vecx and flash carts
- ! Keep a one-command build (`compile.sh` / `task build`) and a one-command run (`run.sh` → fresh ROM copy in emulator)

### Assembler
- ? Use 6809 asm (as09 / Vide / similar) when cycle-level VIA control is the primary design
- ~ Prefer BIOS calls for text, sound setup, and joystick unless a measured need forces direct VIA

### Emulator & Hardware
- ! Use [Vecx](https://github.com/jhawthorn/vecx) (or equivalent) as the daily driver emulator
- ~ Test on real Vectrex + flash cart before release — intensity, persistence, and overruns look different on CRT
- ~ Keep a geometry / calibration card (`geom test`) behind a compile flag for beam and scale checks

## Standards

### Boot & BIOS
- ! Set BIOS cartridge header fields (copyright 4 chars, title, title position/size) via VectreC pragmas or asm equivalents
- ! Enter the main loop with `Wait_Recal` (or VectreC `wait_recal`) as the frame gate
- ! Call `Do_Sound` / `do_sound` once per frame after recal so BIOS music/SFX state advances
- ! Poll controllers once per frame (`Joy_Digital` / `controller_check_buttons` + button read) — not mid-draw
- ⊗ Assume RAM, VIA, text size, or intensity survive across frames without re-init

### Frame Loop (50 Hz)
- ! Structure every frame: **recal → sound → input → logic → draw → (optional) re-arm audio**
- ! Detect refresh overruns via VIA IFR Timer 2 (`VIA_INT_FLAGS` bit 5 / `0x20`) after drawing
- ! Cap catch-up logic ticks after an overrun (max 1–2); prefer shedding draw work over triple-stepping gameplay
- ! Keep gameplay speed consistent under load — never let a heavy frame permanently slow the simulation
- ~ Maintain a `draw_light` (or equivalent) flag: when the previous frame overran, skip decorative / secondary vectors first
- ≉ Busy-wait large idle slices inside the draw path; let `Wait_Recal` absorb idle time
- ⊗ Ignore T2 overruns — they cause hitching and “rubber band” game speed on real hardware

### Vector Drawing
- ! Zero the beam (`Reset0Ref` / `reset0ref`) before absolute positioning and periodically during long continuous passes
- ! Set intensity and scale explicitly before each major draw group — BIOS text routines leave VIA T1 / scale in a bad state for meshes
- ! Keep a safe screen margin; clip or bounce entities before they walk off the CRT
- ! Prefer short relative strokes for shapes; re-zero every N items in continuous passes to fight integrator drift
- ~ Use dual-scale “sync mesh” (move at high scale, stroke at lower scale) for dense outlines when BIOS `Draw_Line` is too soft/slow
- ~ Draw critical gameplay silhouettes first; ornaments, tips, and particles last (and drop them under `draw_light`)
- ≉ Interleave `Print_Str` / BIOS text with vector meshes without restoring `set_scale(0x7F)` (and intensity) afterward
- ⊗ Assume the beam position after a long relative chain — re-zero when accuracy matters

### VIA / AY Bus Safety
- ! Treat VIA port_b mux pokes used for sync-mesh / DAC as hostile to the AY bus — they stomp sound
- ! Re-arm / poke AY registers **after** vector drawing (and before the long `Wait_Recal` idle) so voices survive to the next frame
- ! Keep `dp` correct for BIOS calls (`dp_to_d0` as required by the stdlib wrappers you use)
- ⊗ Leave the shift register unblanked across unintended moves
- ⊗ Call BIOS text or joystick routines in the middle of a custom VIA mesh without restoring VIA state

### Timing & Feel
- ! Drive motion from fixed 50 Hz ticks with sub-pixel accumulators (`int16` position × scale) for smooth travel
- ! Use hysteresis / sticky thresholds on analog-ish or noisy digital decisions (edge detect buttons; debounce mode edges)
- ! Give special modes a short **intro flourish** (~0.5–1 s): intensity pulse, scale pop, banner text — then settle into steady play
- ~ Smooth large state transitions (mode on/off, camera/scale changes) over several frames — avoid hard visual snaps
- ~ Cap per-frame simulation catch-up; never spiral after a hitch
- ≉ Tie critical gameplay speed to variable draw cost without an overrun policy

### Memory & ROM
- ! Prefer `int8_t` / `uint8_t` for positions, counts, and state; widen only when overflow was measured (e.g. long travel distances)
- ! Keep hot tables in ROM (orbit rings, meshes, level defs); keep mutable state tiny and documented
- ~ Pack level / mode flags into bitmasks when tip cards or unlocks must survive retries
- ~ Single translation unit is fine for small games; split only when link/size or clarity demands it
- ⊗ Grow RAM buffers “just in case” — measure first

### Input
- ! Read buttons through BIOS helpers; distinguish **edge** (pressed this frame) from **level** (held)
- ! Document button mapping in README (Button 1–4 roles)
- ~ Keep title / retry / in-game actions on Button 1 when possible for Vectrex-native feel
- ⊗ Poll the joystick every vector stroke

### Sound
- ! Own a clear voice budget (e.g. music vs SFX channels) and document who may stomp whom
- ! Gate looping whoops / drones so they do not fight death / UI one-shots
- ~ Prefer short framed SFX counters (`sfx_t--`) over open-ended AY spam
- ~ Silence or release voices on state changes (title ↔ play ↔ death)
- ⊗ Assume AY state survives a sync-mesh draw pass — re-poke after drawing

### Game Structure
- ! Use an explicit state machine (title, tip, intro, play, death, win, fail, …)
- ! Keep one primary hazard / set-piece focus per level when vector budget is tight
- ~ Use tip cards once per unlock (bitmask), not on every retry
- ~ Prefers authored early levels + procedural later boards over huge static ROM tables
- ~ Mirror mode / power / prize beats with readable vector cues (intensity, dashed outlines, brief labels)

### Code Quality
- ! Comment VIA timing hazards, scale restores, and overrun policy inline where they occur
- ! Name BIOS wrappers consistently (`snake_case` in C; match stdlib)
- ~ Keep draw helpers pure-ish: position in, beam side effects documented
- ~ Provide `#define` feature flags for diagnostics (geom test, death telemetry) defaulting off in release
- ≉ Copy/paste mesh draw sequences without a shared helper — drift and blanking bugs multiply

### Testing & Debugging
- ! Verify the ROM boots in Vecx after every meaningful draw or timing change
- ! Watch for: integrator drift, intensity stuck low/high, audio dropouts after mesh draws, frame hitching
- ~ Use a compile-time geom card to validate scale, zeroing, and clip margins
- ~ When gameplay “feels jumpy”, check overrun catch-up and `draw_light` before rewriting physics
- ~ Test on hardware before tagging a release
- ? Capture death-cause telemetry behind a debug flag for hard-to-repro collision bugs

### Anti-Patterns
- ⊗ Draw first, recal later (breaks 50 Hz contract)
- ⊗ Unlimited logic catch-up after a late frame
- ⊗ BIOS text immediately before meshes without restoring scale/intensity
- ⊗ Continuous relative draws of the whole scene with no periodic `Reset0Ref`
- ⊗ Sharing AY and VIA mux without an end-of-frame re-arm
- ⊗ Hard-coding host absolute toolchain paths into committed scripts without env override
- ⊗ Treating Vecx-only success as hardware-ready

## Patterns

### Frame skeleton (VectreC-style)

```c
for (;;) {
    wait_recal();
    do_sound();
    intensity_a(0x7f);
    set_scale(0x7f);
    poll_input();

    update_game(play_catch_up ? 2 : 1);   /* cap catch-up */
    draw_game(draw_light);                /* shed ornaments if light */

    /* After meshes: re-poke AY if VIA draw stomped the PSG. */
    rearm_sfx();

    if (VIA_INT_FLAGS & VIA_T2_IFR) {
        play_catch_up = 1;
        draw_light = 1;
    } else {
        play_catch_up = 0;
        draw_light = 0;
    }
}
```

### Safe mesh after text

```c
print_str_c(y, x, "READY");
set_scale(0x7f);          /* Print_Str leaves T1 wrong for vectors */
intensity_a(0x7f);
reset0ref();
draw_player_mesh();
```

### Mode intro flourish

```c
/* On mode start: ~36 frames @ 50Hz. Pulse intensity / scale, show banner,
   then clear intro and run steady mode logic. */
if (mode_intro_t > 0) {
    uint8_t t = mode_intro_t--;
    intensity_a(0x40 + (t * 2));
    draw_banner(mode_name);
}
```

## Compliance Checklist

- ! `Wait_Recal` / `wait_recal` gates the frame; sound + input run before draw
- ! Overrun detection + capped catch-up + draw shedding policy documented in code
- ! Scale/intensity restored after any BIOS text
- ! Periodic `Reset0Ref` in long draw passes; safe screen margins enforced
- ! AY re-armed after custom VIA mesh draws
- ! Sub-pixel or phase accumulators for smooth motion; sticky input where needed
- ! Mode changes get a short readable flourish
- ! Toolchain paths via env (`VECTREC`, emulator app); one-command build & run
- ! See [c.md](../languages/c.md) for general C compliance when using VectreC
- ! Run project `task check` / `./compile.sh` before commit
- ⊗ Ship without Vecx verification; tag a release without a hardware smoke test when possible

## Resources

- [Vectrex — Wikipedia](https://en.wikipedia.org/wiki/Vectrex) — hardware overview
- [VectreC](https://github.com/rogerboesch/vectreC) — CMOC toolchain + Vectrex stdlib
- [Vecx](https://github.com/jhawthorn/vecx) — portable Vectrex emulator
- [Vectrex Programming TOC (Malban)](http://vectorgaming.proboards.com/) — community techniques, sync lists, tutorials
- [AY-3-8910 Datasheet](https://github.com/mamedev/mame/blob/master/src/devices/sound/ay8910.cpp) — PSG behavior reference (via MAME docs / datasheets)
- [6809 Instruction Set](http://www.maddes.net/m6809pm/sections.htm) — CPU reference
- Classic BIOS disassemblies / `FRAMES.TXT` style notes — `Wait_Recal`, intensity, and joystick contracts
