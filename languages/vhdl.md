# VHDL Standards

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [main.md](../main.md) | [PROJECT.md](../PROJECT.md)

## Standards

### Clocking

- ! Use a single, common clock across the entire project
- ! All sequential logic uses the same clock edge (rising_edge preferred)
- ! Use clock enables instead of gated clocks for different timing domains
- ! Generate all enables inside a process of a clock edge
- ⊗ Divide clocks internally; use PLL/MMCM for clock generation
- ~ Use dedicated clock resources (BUFG, BUFR) for clock distribution
- ~ When CDC is unavoidable, use dual-flop synchronizers or async FIFOs

### Reset

- ! Use synchronous reset for all registers
- ~ Active-high reset naming: `rst`; active-low: `rst_n`
- ⊗ Mix synchronous and asynchronous resets in the same design
- ? Initialize flip-flops at declaration for FPGAs (avoids reset logic)

### Packages & Libraries

- ! Use `ieee.std_logic_1164` for logic types
- ! Use `ieee.numeric_std` for arithmetic (never `std_logic_arith`/`std_logic_unsigned`)
- ⊗ Use non-IEEE packages for synthesizable code

### Signal Naming

- ! Use meaningful, descriptive names (`temperature_sensor_output` not `temp`)
- ~ Use prefixes: `i_` (input), `o_` (output), `r_` (register), `w_` (wire/combinational)
- ~ Use prefixes: `c_` (constant), `g_` (generic), `t_` (user-defined type)
- ~ Use lowercase for signals, UPPERCASE for constants
- ! Use underscores for multi-word identifiers (`data_valid` not `datavalid`)

### Architecture & Process

- ! Separate behavioral RTL from structural code (different architectures)
- ~ Use two-process coding style: one combinational, one sequential
- ! Every process has a descriptive label and header comment
- ⊗ Create latches; all if/case branches must assign all signals
- ⊗ Create combinational feedback loops
- ~ Use variables sparingly in synthesizable code; prefer signals
- ! Variables in functions are acceptable

### Port & Signal Declarations

- ! Use `std_logic` for single-bit ports, `std_logic_vector` for buses
- ~ Declare vector ranges consistently (`downto` for data, `to` for arrays)
- ≉ Use `inout` mode except at top-level I/O pads
- ! Use `open` explicitly for unconnected output ports

### Instantiation

- ! Use named port maps (not positional) for all instantiations
- ? Use positional generic maps only if ≤2 generics
- ~ Use direct entity instantiation over component declarations

### State Machines

- ! Use enumerated types for FSM states
- ! Include a default/`when others` case that goes to a safe state
- ~ Document encoding style (one-hot, binary, gray) in comments
- ~ Use two-process FSM: one for state register, one for next-state/output logic

### Operators & Expressions

- ~ Avoid VHDL-93 rotate/shift operators; use slices & concatenation
- ⊗ Multiply Signed/Unsigned directly by Integer (use type conversion)
- ~ Use parentheses to clarify operator precedence

### Documentation

- ! Include header comment block: author, date, description, revision history
- ! Document all entities: purpose, port descriptions, timing assumptions
- ! Comment every process explaining its function
- ~ Use `--` comments liberally to clarify intent

### Testbenches

- ! Create a testbench for every synthesizable entity
- ! Use `assert` and `report` statements for self-checking tests
- ~ Use variables freely in testbenches for readability
- ~ Stop simulation via event starvation (stop clock) or `severity failure`
- ! Verify all corner cases and boundary conditions

### Synthesis & Implementation

- ⊗ Use internal tristates; tristate only at I/O pads
- ⊗ Rely on initial values in ASIC flows (use reset)
- ~ Place timing-critical logic in dedicated DSP/BRAM resources
- ~ Use synthesis attributes (`keep`, `async_reg`) when needed

## Commands

```bash
task build              # Synthesize design
task sim                # Run simulation
task sim:gui            # Run simulation with waveform viewer
task lint               # Run VHDL linting/style checks
task quality            # All quality checks
task check              # Pre-commit (lint + sim)
```

## 🔧 Patterns

**Two-Process FSM**:

```vhdl
-- Sequential process (registers only)
p_fsm_seq : process(clk)
begin
  if rising_edge(clk) then
    if rst = '1' then
      state <= IDLE;
    else
      state <= next_state;
    end if;
  end if;
end process p_fsm_seq;

-- Combinational process (next state + outputs)
p_fsm_comb : process(state, inputs)
begin
  next_state <= state;  -- Default: hold state
  outputs <= '0';       -- Default outputs
  case state is
    when IDLE =>
      if start = '1' then
        next_state <= RUN;
      end if;
    when RUN =>
      outputs <= '1';
      next_state <= DONE;
    when others =>
      next_state <= IDLE;
  end case;
end process p_fsm_comb;
```

**Dual-Flop Synchronizer** (when CDC is unavoidable):

```vhdl
p_sync : process(clk)
begin
  if rising_edge(clk) then
    r_sync_1 <= i_async_signal;
    r_sync_2 <= r_sync_1;
  end if;
end process p_sync;
o_sync_signal <= r_sync_2;
```

**Entity Header Template**:

```vhdl
-------------------------------------------------------------------------------
-- Entity:      my_module
-- Author:      Name
-- Date:        YYYY-MM-DD
-- Description: Brief description of module function
-- Assumptions: Clock frequency, timing requirements
-- Revision:    1.0 - Initial version
-------------------------------------------------------------------------------
```

## Compliance Checklist

- ! Single common clock used throughout project
- ! All sequential logic uses `rising_edge(clk)`
- ! Synchronous reset implemented
- ! ieee.numeric_std used (no std_logic_arith)
- ! No latches inferred
- ! All FSMs have `when others` clause
- ! Named port maps for all instantiations
- ! Run `task check` before commit
