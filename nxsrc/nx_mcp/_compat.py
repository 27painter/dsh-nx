# -*- coding: utf-8 -*-
"""Python 3.6 compatibility layer for the code that runs inside NX 12.

NX 12 embeds CPython 3.6.1, so several things upstream relies on are missing:
``dataclasses`` (3.7), ``str.isascii()`` (3.7) and ``typing.Literal`` (3.8),
plus the ``from __future__ import annotations`` line those modules carried.

**This module is a pass-through on 3.7+.** The sidecar runs on the host with
Python 3.10+, and there it must get the real ``dataclasses`` — Pydantic inspects
``__dataclass_fields__`` and rejects anything that merely imitates one. Only the
embedded 3.6 interpreter takes the shim branch.

The interpreters NX embeds, and what each one gets:

    NX 12      CPython 3.6.1   shim branch (verified)
    NX 2406    CPython 3.10    pass-through (verified)
    NX 2506    CPython 3.12    pass-through (same code path, not yet run)

Nothing here is a version switch: the branch is chosen by what imports, so a
release with a newer interpreter cannot silently land in the 3.6 path.
"""
try:  # 3.7+
    from dataclasses import asdict, dataclass, field  # noqa: F401

    _SHIM = False
except ImportError:  # NX 12: CPython 3.6.1
    import copy

    _SHIM = True
    _MISSING = object()

    class _Field:
        __slots__ = ("default", "default_factory")

        def __init__(self, default=_MISSING, default_factory=None):
            self.default = default
            self.default_factory = default_factory

        def value(self):
            if self.default_factory is not None:
                return self.default_factory()
            return self.default

    def field(*, default=_MISSING, default_factory=None, **kwargs):
        if kwargs.get("init") is False:
            raise NotImplementedError("field(init=False) is not supported by this shim")
        return _Field(default=default, default_factory=default_factory)

    def _collect_fields(cls):
        collected = []
        seen = set()
        for klass in reversed(cls.__mro__):
            for name in klass.__dict__.get("__annotations__", {}):
                if name.startswith("_") or name in seen:
                    continue
                seen.add(name)
                collected.append((name, klass.__dict__.get(name, _MISSING)))
        return collected

    def dataclass(_cls=None, *, frozen=False, eq=True, repr=True, **kwargs):
        def wrap(cls):
            fields = _collect_fields(cls)

            def __init__(self, *args, **kw):
                if len(args) > len(fields):
                    raise TypeError(
                        "%s() takes %d positional arguments but %d were given"
                        % (cls.__name__, len(fields), len(args))
                    )
                given = set()
                for (name, _raw), value in zip(fields, args):
                    object.__setattr__(self, name, value)
                    given.add(name)
                for name, _raw in fields[len(args):]:
                    if name in kw:
                        given.add(name)
                        object.__setattr__(self, name, kw.pop(name))
                if kw:
                    raise TypeError(
                        "%s() got unexpected keyword arguments %s"
                        % (cls.__name__, ", ".join(sorted(kw)))
                    )
                for name, raw in fields:
                    if name in given:
                        continue
                    # field() leaves a _Field on the class, so "already set" has
                    # to be tested against the instance dict, not hasattr().
                    if name in self.__dict__:
                        continue
                    if isinstance(raw, _Field):
                        if raw.default is not _MISSING:
                            object.__setattr__(self, name, raw.default)
                        else:
                            object.__setattr__(self, name, raw.value())
                    elif raw is not _MISSING:
                        object.__setattr__(self, name, copy.copy(raw))
                    else:
                        raise TypeError(
                            "%s() missing required argument: %r" % (cls.__name__, name)
                        )

            def __repr__(self):
                body = ", ".join("%s=%r" % (n, getattr(self, n)) for n, _ in fields)
                return "%s(%s)" % (cls.__name__, body)

            def __eq__(self, other):
                if other.__class__ is not self.__class__:
                    return NotImplemented
                return all(getattr(self, n) == getattr(other, n) for n, _ in fields)

            def __hash__(self):
                return hash(tuple(getattr(self, n) for n, _ in fields))

            cls.__init__ = __init__
            cls.__dataclass_fields__ = {n: r for n, r in fields}
            if repr:
                cls.__repr__ = __repr__
            if eq:
                cls.__eq__ = __eq__
                cls.__hash__ = __hash__
            if frozen:

                def _frozen_setattr(self, name, value):
                    raise AttributeError("cannot assign to field %r" % name)

                cls.__setattr__ = _frozen_setattr
            return cls

        if _cls is None:
            return wrap
        return wrap(_cls)

    def asdict(instance):
        out = {}
        for name, _raw in _collect_fields(instance.__class__):
            value = getattr(instance, name)
            if hasattr(value, "__dataclass_fields__"):
                out[name] = asdict(value)
            elif isinstance(value, (list, tuple)):
                out[name] = [asdict(v) if hasattr(v, "__dataclass_fields__") else v for v in value]
            elif isinstance(value, dict):
                out[name] = {
                    k: (asdict(v) if hasattr(v, "__dataclass_fields__") else v)
                    for k, v in value.items()
                }
            else:
                out[name] = value
        return out


try:  # 3.8+
    from typing import Literal  # noqa: F401
except ImportError:  # 3.6 / 3.7
    class _LiteralAlias:
        """`Literal["a", "b"]` is only a type alias here and annotations are
        strings, so subscripting only has to not raise."""

        def __getitem__(self, item):
            return str

    Literal = _LiteralAlias()  # type: ignore[assignment]


def is_shim():
    """True when the compatibility implementations above are in use."""
    return _SHIM
