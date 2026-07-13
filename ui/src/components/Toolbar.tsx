interface Props {
  title: string;
  sub?: string;
  children?: React.ReactNode;
}

/**
 * Shared screen toolbar: title, optional context text, and arbitrary children
 * (screen-specific controls).
 *
 * Suspend/Resume has moved to the Titlebar's "Pause Conduit" control.
 */
export function Toolbar({ title, sub, children }: Props) {
  return (
    <div className="toolbar">
      <span className="toolbar__title">
        {title}
        {sub && <small className="toolbar__sub">{sub}</small>}
      </span>

      {children}

      <span className="toolbar__spacer" />
    </div>
  );
}
