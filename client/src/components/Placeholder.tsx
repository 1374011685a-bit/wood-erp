type PlaceholderProps = {
  title: string
  hint?: string
}

export default function Placeholder({ title, hint }: PlaceholderProps) {
  return (
    <section className="page">
      <h1 className="page-title">{title}</h1>
      <div className="page-body">开发中</div>
      {hint ? <p className="page-hint">{hint}</p> : null}
    </section>
  )
}
