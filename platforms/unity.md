# Unity Standards

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [main.md](../main.md) | [PROJECT.md](../PROJECT.md) | [csharp.md](../languages/csharp.md)

**Stack**: Unity 6+, C# (see [csharp.md](../languages/csharp.md) for general C# rules); Rendering: URP (default) or HDRP; Testing: Unity Test Framework (NUnit); Asset Management: Addressables

**Note**: Rules in [csharp.md](../languages/csharp.md) apply to all Unity C# code. This file covers Unity-specific overrides and additions.

## Standards

### Project Structure

- ! Use Assembly Definition files (`.asmdef`) for all script folders — separate Runtime, Editor, and Tests
- ! Organize by feature or domain (`Player/`, `UI/`, `Audio/`, `Networking/`), not by type (`Scripts/`, `Prefabs/`)
- ! Place all project assets under a top-level folder named after the project (e.g., `Assets/MyGame/`)
- ! Match namespaces to folder structure
- ! One public class per file; filename matches the class name
- ~ Use a consistent asset naming convention: `Prefix_BaseAssetName_Variant_Suffix`
- ~ Keep a `_Shared/` or `Common/` folder for cross-feature assets
- ⊗ Leave loose assets in `Assets/` root

### Naming Conventions (Unity-Specific)

- ! `PascalCase` for MonoBehaviours, ScriptableObjects, classes, methods, properties, events
- ! `camelCase` for parameters and local variables
- ! `_camelCase` for private/protected fields
- ! `[SerializeField] private` fields instead of `public` for Inspector-exposed values
- ! Use `[Header("Section")]` and `[Tooltip("Description")]` to document Inspector fields
- ~ Suffix scripts by role: `*Controller`, `*Manager`, `*System`, `*Data`, `*Settings`, `*Editor`
- ~ Use `I` prefix for interfaces: `IDamageable`, `IInteractable`
- ⊗ Hungarian notation or type prefixes (`strName`, `intCount`, `goPlayer`)

### MonoBehaviour Guidelines

- ! Keep MonoBehaviours thin — glue between data/systems and visuals only
- ! Cache component references in `Awake()` or `OnEnable()`; ⊗ call `GetComponent<T>()` in `Update()`
- ! Remove empty Unity lifecycle methods (`Update()`, `Start()`, etc.) — they have overhead even when empty
- ! Order members: Fields → Properties → Events → Unity Lifecycle → Public Methods → Private Methods
- ~ Use `[RequireComponent(typeof(T))]` to enforce dependencies
- ~ Use `[DisallowMultipleComponent]` where only one instance makes sense
- ≉ Use `Awake()` for cross-object dependencies; use `Start()` or lazy init instead
- ⊗ Use `SendMessage()`, `BroadcastMessage()`, or `Invoke()` with string method names

### ScriptableObjects

- ! Use ScriptableObjects for shared configuration, game data, and design-tunable parameters
- ! Use `[CreateAssetMenu]` attribute for designer-facing ScriptableObjects
- ~ Use ScriptableObject-based events for decoupled inter-system communication (observer pattern)
- ~ Use ScriptableObject variables (e.g., `FloatVariable`, `IntVariable`) for shared runtime state
- ~ Copy runtime values from ScriptableObject data to avoid persisting play-mode changes to disk
- ~ Favor ScriptableObjects over singletons for global state and cross-scene data
- ≉ Store mutable per-instance state in ScriptableObjects (they are shared assets)

### Architecture & Patterns

- ! Favor composition over inheritance for game behaviors
- ! Apply SOLID principles; keep classes single-responsibility
- ! Use event-driven communication (C# events, ScriptableObject events, or `UnityEvent`) over direct references
- ~ Use dependency injection (VContainer or similar) for testable architecture
- ~ Use interfaces to define contracts between systems
- ~ Hybrid approach: GameObjects for scene logic + Jobs/Burst for compute-heavy paths
- ≉ Deep MonoBehaviour inheritance hierarchies (prefer composition)
- ≉ Global singletons as primary architecture — use ScriptableObjects or DI instead
- ? Use ECS/DOTS for entity-heavy systems (physics, AI, large simulations)

### Performance & Memory

- ! Profile first — use Unity Profiler and Project Auditor before optimizing
- ! Eliminate per-frame heap allocations in hot paths (Update, FixedUpdate, coroutines)
- ! Use object pooling (`UnityEngine.Pool.ObjectPool<T>`) for frequently spawned/despawned objects
- ! Cache all expensive lookups: `GetComponent<T>()`, `Camera.main`, `Transform` references
- ! Cache `WaitForSeconds` and other yield instructions in coroutines
- ! Use non-allocating Physics APIs: `Physics.RaycastNonAlloc()`, `Physics.OverlapSphereNonAlloc()`
- ~ Reuse collections (`List<T>`, `StringBuilder`, arrays) instead of allocating new ones
- ~ Use `Span<T>` and `ReadOnlySpan<T>` for zero-allocation slicing
- ~ Prefer structs for small data-only types on hot paths
- ~ Use Jobs + Burst Compiler for heavy math, physics, AI, and procedural generation
- ~ Use `Awaitable` (Unity 6+, pooled, player-loop aware) over raw `Task` for async
- ≉ Use LINQ, reflection, or string concatenation in hot paths
- ⊗ Call `GameObject.Find()`, `FindObjectOfType()`, or `FindObjectsOfType()` at runtime in hot paths
- ⊗ Use `Resources.Load()` at runtime — use Addressables instead

### Asset Management

- ! Use Addressables for all runtime asset loading in production projects
- ! Set up asset groups with sensible packing strategies (by label, scene, feature)
- ! Release loaded Addressables when no longer needed to free memory
- ~ Pre-warm object pools during loading screens or scene initialization
- ~ Use texture compression appropriate to target platform (ASTC for mobile, BC7 for desktop)
- ~ Enable mipmaps for 3D textures; disable for UI/2D sprites
- ~ Use Sprite Atlases for 2D/UI to reduce draw calls
- ≉ Use `Resources/` folder for production assets (non-strippable, increases build size)

### Rendering

- ! Choose render pipeline at project start: URP (default/mobile) or HDRP (high-fidelity)
- ! Use SRP Batcher–compatible shaders for draw call optimization
- ! Implement LOD (Level of Detail) for 3D assets
- ! Use occlusion culling for complex 3D scenes
- ~ Enable GPU Instancing for repeated meshes (foliage, debris, crowds)
- ~ Use static batching for non-moving geometry
- ~ Use Shader Graph for custom shaders; avoid hand-written shaders unless performance demands it
- ~ Set per-platform quality levels and resolution scaling
- ? Use UI Toolkit for new UI work; uGUI for legacy or simple use cases

### Unity-Specific C# Gotchas

- ! Use `if (myUnityObject == null)` — Unity overrides `==` on `UnityEngine.Object` (fake null)
- ! Use `Object.Destroy()` at runtime; `DestroyImmediate()` is Editor-only
- ! All Unity API calls must execute on the main thread
- ! Guard Editor-only code with `#if UNITY_EDITOR` and separate Assembly Definitions
- ! Use `CompareTag("Tag")` instead of `gameObject.tag == "Tag"` (avoids allocation)
- ⊗ Use `ReferenceEquals(obj, null)` or `is null` on UnityEngine.Object types
- ⊗ Use C# finalizers (`~ClassName()`) in runtime code
- ⊗ Use `async void` — use `async Awaitable` (Unity 6+) or coroutines

### Testing

See [testing.md](../coding/testing.md) for universal testing requirements.

- ! Use Unity Test Framework (NUnit-based) for all automated tests
- ! Separate Edit Mode and Play Mode tests into distinct assemblies (`.asmdef`)
- ! Use `[Test]` for synchronous logic; `[UnityTest]` only when yielding frames or time
- ! Test assemblies must reference production assemblies via Assembly Definitions
- ~ Write Edit Mode tests for pure logic, ScriptableObject behavior, and Editor extensions
- ~ Write Play Mode tests for runtime behaviors, physics, coroutines, and integration
- ~ Use `LogAssert.Expect()` before log-emitting code under test
- ~ Run tests in CI via batch mode: `-batchmode -runTests -testPlatform EditMode`
- ~ Install Code Coverage package (`com.unity.testtools.codecoverage`) for coverage reports
- ? Run Play Mode tests on target platform builds for platform-specific validation

### Coverage

- ! ≥75% coverage for runtime logic assemblies
- ! Exclude Editor scripts, generated code, and third-party plugins from coverage
- ~ Prioritize coverage on gameplay systems, state machines, and data processing

### Editor Workflow

- ! Enable "Enter Play Mode Options" (disable Domain Reload) for fast iteration
- ! Manually reset all static fields when Domain Reload is disabled
- ~ Use Roslyn analyzers and `.editorconfig` for code style enforcement
- ~ Use custom Editor tools and PropertyDrawers to improve designer workflows
- ~ Use `[ContextMenu("...")]` for quick debug actions on components
- ? Use Presets for standardizing import settings across asset types

### Source Control

- ! Use a Unity-appropriate `.gitignore` (exclude `Library/`, `Temp/`, `Logs/`, `obj/`)
- ! Set Asset Serialization to "Force Text" (Project Settings → Editor)
- ! Enable Visible Meta Files (Project Settings → Editor → Version Control Mode)
- ! Use `.gitattributes` to mark binary assets (textures, audio, models) with Git LFS
- ~ Use Smart Merge (UnityYAMLMerge) for scene and prefab conflict resolution
- ~ Commit `.meta` files alongside their assets — never delete one without the other

### Native Plugins (C++/Rust)

- ~ Only reach for native plugins when Jobs + Burst is insufficient
- ! Expose a C-style interface (`extern "C"`) to avoid name mangling
- ! Use `[DllImport("PluginName")]` in C# (`"__Internal"` for iOS)
- ! Minimize P/Invoke boundary crossings — batch work inside the native library
- ! Place platform-specific binaries in correct `Plugins/` subfolders
- ? Prefer Rust over C++ for new native plugins (memory safety, fewer crashes)

### Safety

- ⊗ Hardcode secrets, API keys, or credentials in source or ScriptableObjects
- ! Validate all external input (network data, user input, file I/O)
- ~ Scan third-party packages for vulnerabilities before importing
- ~ Use signed packages (Unity 6.3+) and verify trust indicators in Package Manager

## Anti-Patterns

Items marked ⊗ in Standards above are not repeated here.

- ≉ **God MonoBehaviours**: Split large scripts (>300 lines) into focused components
- ≉ **Deep inheritance**: Favor composition and interfaces over class hierarchies
- ≉ **String-based identification**: Use enums, ScriptableObject references, or tags — not magic strings
- ≉ **Scene-dependent singletons**: Use ScriptableObjects or DI for cross-scene state
- ≉ **Resources folder**: Use Addressables for runtime loading
- ≉ **Coroutines for everything**: Use `async/Awaitable` (Unity 6+) for non-frame-dependent async
- ≉ **Manual `new` for poolable objects**: Use `ObjectPool<T>` or Addressables pooling

## Patterns

### ScriptableObject Variable

```csharp
[CreateAssetMenu(menuName = "Variables/Float")]
public class FloatVariable : ScriptableObject
{
    [SerializeField] private float _initialValue;

    [System.NonSerialized] public float RuntimeValue;

    private void OnEnable() => RuntimeValue = _initialValue;
}
```

### ScriptableObject Event

```csharp
[CreateAssetMenu(menuName = "Events/Game Event")]
public class GameEvent : ScriptableObject
{
    private readonly List<GameEventListener> _listeners = new();

    public void Raise()
    {
        for (int i = _listeners.Count - 1; i >= 0; i--)
            _listeners[i].OnEventRaised();
    }

    public void Register(GameEventListener listener) => _listeners.Add(listener);
    public void Unregister(GameEventListener listener) => _listeners.Remove(listener);
}

public class GameEventListener : MonoBehaviour
{
    [SerializeField] private GameEvent _event;
    [SerializeField] private UnityEvent _response;

    private void OnEnable() => _event.Register(this);
    private void OnDisable() => _event.Unregister(this);
    public void OnEventRaised() => _response.Invoke();
}
```

### Object Pooling (Unity 2021+)

```csharp
public class ProjectilePool : MonoBehaviour
{
    [SerializeField] private Projectile _prefab;
    private ObjectPool<Projectile> _pool;

    private void Awake()
    {
        _pool = new ObjectPool<Projectile>(
            createFunc: () => Instantiate(_prefab),
            actionOnGet: p => p.gameObject.SetActive(true),
            actionOnRelease: p => p.gameObject.SetActive(false),
            actionOnDestroy: p => Destroy(p.gameObject),
            defaultCapacity: 20,
            maxSize: 100
        );
    }

    public Projectile Get() => _pool.Get();
    public void Release(Projectile p) => _pool.Release(p);
}
```

### Cached Component References

```csharp
[RequireComponent(typeof(Rigidbody))]
public class PlayerMovement : MonoBehaviour
{
    private Rigidbody _rb;
    private Transform _transform;

    private void Awake()
    {
        _rb = GetComponent<Rigidbody>();
        _transform = transform; // Cache the property accessor
    }

    private void FixedUpdate()
    {
        // Use cached references — never GetComponent in Update/FixedUpdate
        _rb.AddForce(_transform.forward * 10f);
    }
}
```

### Play Mode Test

```csharp
[UnityTest]
public IEnumerator Rigidbody_WithGravity_FallsOverTime()
{
    var go = new GameObject("TestObj");
    go.AddComponent<Rigidbody>();
    var startY = go.transform.position.y;

    yield return new WaitForSeconds(1f);

    Assert.Less(go.transform.position.y, startY);
    Object.Destroy(go);
}

[Test]
public void FloatVariable_OnEnable_ResetsToInitialValue()
{
    var variable = ScriptableObject.CreateInstance<FloatVariable>();
    // Test pure logic without frames — use [Test], not [UnityTest]
    Assert.AreEqual(0f, variable.RuntimeValue);
}
```

## Compliance Checklist

- ! Assembly Definitions for all script folders (Runtime, Editor, Tests)
- ! `[SerializeField] private` for Inspector fields; no public fields for serialization
- ! ScriptableObjects for shared data, configuration, and events
- ! Object pooling for frequently spawned objects
- ! Addressables for runtime asset loading (not `Resources/`)
- ! Unity Test Framework with separate Edit Mode and Play Mode assemblies
- ! Profile with Unity Profiler before and after optimization
- ! Zero per-frame heap allocations in hot paths
- ! Force Text serialization + Visible Meta Files for version control
- ! See [csharp.md](../languages/csharp.md) for general C# compliance
- ⊗ `GetComponent` in `Update`, `GameObject.Find` at runtime, empty lifecycle methods
- ! Run `task check` before commit

## Resources

- [Unity Programming Best Practices Manual](https://docs.unity3d.com/6000.3/Documentation/Manual/best-practice-guides.html)
- [C# Code Style Guide for Unity 6](https://unity.com/resources/c-sharp-style-guide-unity-6) (2nd ed., 2025)
- [Create Modular Architecture with ScriptableObjects](https://unity.com/how-to/architect-game-code-scriptable-objects) (e-book + demo)
- [Level Up Your Code with Game Programming Patterns](https://unity.com/how-to/level-up-your-code-with-game-programming-patterns) (SOLID + design patterns)
- [Unity Test Framework Documentation](https://docs.unity3d.com/Packages/com.unity.test-framework@2.0/manual/index.html)
- [Unity Performance Optimization (PC/Console)](https://docs.unity3d.com/6000.3/Documentation/Manual/best-practice-guides.html)
- [Unity Performance Optimization (Mobile/XR/Web)](https://docs.unity3d.com/6000.3/Documentation/Manual/best-practice-guides.html)
- [Addressables Documentation](https://docs.unity3d.com/Packages/com.unity.addressables@latest)
- [Unity 6 Roadmap (Unite 2025)](https://www.youtube.com/watch?v=rEKmARCIkSI)
