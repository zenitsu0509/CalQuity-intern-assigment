import './globals.css'

export const metadata = {
  title: 'AI Search Chat',
  description: 'Perplexity-style chat with citations',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  )
}
