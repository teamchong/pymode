// Build script for Zig replacement modules
// Each module compiles to a shared library (.so/.dylib) that CPython can load
// For WASM builds, they compile to .wasm modules linked into the main binary

const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // Path to CPython headers
    const cpython_include = b.option([]const u8, "cpython-include", "Path to CPython include dir") orelse "cpython/Include";
    const cpython_internal = b.option([]const u8, "cpython-internal", "Path to CPython internal include") orelse "cpython/Include/internal";

    // Path to metal0 runtime
    const metal0_runtime = b.option([]const u8, "metal0-runtime", "Path to metal0 packages/runtime/src") orelse "../metal0/packages/runtime/src";

    // Build each module
    const modules = [_]struct { name: []const u8, root: []const u8 }{
        .{ .name = "_json", .root = "_json/module.zig" },
        .{ .name = "_hashlib", .root = "_hashlib/module.zig" },
        .{ .name = "_collections", .root = "_collections/module.zig" },
        .{ .name = "_functools", .root = "_functools/module.zig" },
        // .{ .name = "_sre", .root = "_sre/module.zig" },
        // .{ .name = "math", .root = "_math/module.zig" },
        // .{ .name = "_datetime", .root = "_datetime/module.zig" },
    };

    for (modules) |mod| {
        const lib = b.addSharedLibrary(.{
            .name = mod.name,
            .root_source_file = b.path(mod.root),
            .target = target,
            .optimize = optimize,
        });

        // Add CPython headers for @cImport
        lib.addIncludePath(.{ .cwd_relative = cpython_include });
        lib.addIncludePath(.{ .cwd_relative = cpython_internal });

        // Add metal0 runtime source for @import
        lib.addIncludePath(.{ .cwd_relative = metal0_runtime });

        // Link against libpython for CPython API symbols
        lib.linkSystemLibrary("python3.13");

        b.installArtifact(lib);
    }

    // Test step
    const test_step = b.step("test", "Run module tests");
    _ = test_step;
}
