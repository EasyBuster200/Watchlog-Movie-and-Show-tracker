# TextField

A labelled 48px text input for forms (sign in, sign up, password reset, settings).

- `label` sits above the box in `text-secondary`; `aside` puts an element on the right of the label row (e.g. a "Forgot password?" link).
- `icon` adds a leading line icon (`mail`, `lock`, `user`).
- `type="password"` adds a show/hide button (eye / eyeoff) with a 40px target.
- Focus moves the border to `accent-mark`. `error` turns the border and hint `danger` and sets `aria-invalid`; otherwise `helper` shows in `text-muted`.
- The box is `bg-card` with a `border-subtle` hairline, the same as `SearchField`.

```jsx
<TextField label="Email" type="email" icon="mail" placeholder="you@example.com" autoComplete="email" />
<TextField label="Password" type="password" icon="lock" helper="At least 8 characters" />
```
