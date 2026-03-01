export const metadata = {
  title: 'Unieważnienie Kredytu Frankowego - Profesjonalna Pomoc Prawna',
  description: 'Pomożemy Ci unieważnić kredyt frankowy i odzyskać nadpłacone raty. 87% wygranych spraw. Bezpłatna konsultacja. Sprawdź, ile możesz odzyskać!',
  keywords: 'kredyt frankowy, CHF, unieważnienie kredytu, kredyt walutowy, pozew przeciwko bankowi, frank szwajcarski, kredyt hipoteczny CHF',
  authors: [{ name: 'Kredyty Frankowe' }],
  openGraph: {
    title: 'Unieważnienie Kredytu Frankowego - Odzyskaj Pieniądze',
    description: '87% wygranych spraw. Bezpłatna konsultacja. Sprawdź, ile możesz odzyskać z kredytu frankowego!',
    type: 'website',
    locale: 'pl_PL',
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function CHFLayout({ children }) {
  return (
    <html lang="pl">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body>{children}</body>
    </html>
  );
}
