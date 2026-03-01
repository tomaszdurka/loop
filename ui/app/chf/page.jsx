import ProcessTimeline from '../../components/ProcessTimeline';
import Requirements from '../../components/Requirements';
import Statistics from '../../components/Statistics';
import Risks from '../../components/Risks';
import LeadForm from '../../components/LeadForm';

export const metadata = {
  title: 'Unieważnienie Kredytu Frankowego - Profesjonalna Pomoc Prawna',
  description: 'Pomożemy Ci unieważnić kredyt frankowy i odzyskać nadpłacone raty. 87% wygranych spraw. Bezpłatna konsultacja. Sprawdź, ile możesz odzyskać!',
  keywords: 'kredyt frankowy, CHF, unieważnienie kredytu, kredyt walutowy, pozew przeciwko bankowi',
  openGraph: {
    title: 'Unieważnienie Kredytu Frankowego - Odzyskaj Pieniądze',
    description: '87% wygranych spraw. Bezpłatna konsultacja. Sprawdź, ile możesz odzyskać z kredytu frankowego!',
    type: 'website',
    locale: 'pl_PL'
  }
};

export default function CHFLoanPage() {
  return (
    <div className="min-h-screen bg-white">
      {/* Hero Section */}
      <section className="relative bg-gradient-to-br from-blue-900 via-blue-800 to-blue-900 text-white overflow-hidden">
        <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHZpZXdCb3g9IjAgMCA2MCA2MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZyBmaWxsPSJub25lIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiPjxnIGZpbGw9IiNmZmYiIGZpbGwtb3BhY2l0eT0iMC4wNSI+PHBhdGggZD0iTTM2IDE4YzMuMzE0IDAgNiAyLjY4NiA2IDZzLTIuNjg2IDYtNiA2LTYtMi42ODYtNi02IDIuNjg2LTYgNi02ek0yNCA2YzMuMzE0IDAgNiAyLjY4NiA2IDZzLTIuNjg2IDYtNiA2LTYtMi42ODYtNi02IDIuNjg2LTYgNi02eiIvPjwvZz48L2c+PC9zdmc+')] opacity-20"></div>

        <div className="relative max-w-7xl mx-auto px-6 py-20 md:py-32">
          <div className="max-w-4xl">
            <div className="inline-block mb-6 px-4 py-2 bg-blue-700/50 rounded-full text-sm font-semibold backdrop-blur-sm border border-blue-500/30">
              ⚖️ Profesjonalna pomoc prawna
            </div>

            <h1 className="text-4xl md:text-6xl font-bold mb-6 leading-tight">
              Unieważnij kredyt frankowy i odzyskaj pieniądze
            </h1>

            <p className="text-xl md:text-2xl text-blue-100 mb-8 leading-relaxed">
              Pomożemy Ci walczyć z bankiem i odzyskać nadpłacone raty. Ponad 87% naszych klientów
              wygrało w sądzie. Średnie odzyskanie: 250 000 PLN.
            </p>

            <div className="flex flex-wrap gap-4 mb-12">
              <div className="flex items-center gap-2 bg-white/10 backdrop-blur-sm px-4 py-2 rounded-lg">
                <span className="text-2xl">✓</span>
                <span>Bezpłatna konsultacja</span>
              </div>
              <div className="flex items-center gap-2 bg-white/10 backdrop-blur-sm px-4 py-2 rounded-lg">
                <span className="text-2xl">✓</span>
                <span>Sukces fee - płacisz po wygranej</span>
              </div>
              <div className="flex items-center gap-2 bg-white/10 backdrop-blur-sm px-4 py-2 rounded-lg">
                <span className="text-2xl">✓</span>
                <span>Doświadczeni prawnicy</span>
              </div>
            </div>

            <div className="flex flex-wrap gap-4">
              <a
                href="#kontakt"
                className="bg-white text-blue-900 font-bold py-4 px-8 rounded-lg hover:bg-blue-50 transition-all shadow-lg hover:shadow-xl text-lg inline-block"
              >
                Sprawdź swoją sprawę
              </a>
              <a
                href="#proces"
                className="bg-blue-700/50 backdrop-blur-sm border-2 border-white/30 text-white font-bold py-4 px-8 rounded-lg hover:bg-blue-600/50 transition-all text-lg inline-block"
              >
                Zobacz jak to działa
              </a>
            </div>
          </div>
        </div>

        {/* Wave divider */}
        <div className="absolute bottom-0 left-0 right-0">
          <svg viewBox="0 0 1440 120" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-auto">
            <path d="M0 0L60 10C120 20 240 40 360 46.7C480 53 600 47 720 43.3C840 40 960 40 1080 46.7C1200 53 1320 67 1380 73.3L1440 80V120H1380C1320 120 1200 120 1080 120C960 120 840 120 720 120C600 120 480 120 360 120C240 120 120 120 60 120H0V0Z" fill="white"/>
          </svg>
        </div>
      </section>

      {/* Stats Section */}
      <section className="max-w-7xl mx-auto px-6 py-16 md:py-24">
        <div className="text-center mb-12">
          <h2 className="text-3xl md:text-4xl font-bold text-slate-900 mb-4">
            Nasze wyniki mówią same za siebie
          </h2>
          <p className="text-lg text-slate-600 max-w-2xl mx-auto">
            Specjalizujemy się w sprawach frankowych i osiągamy jedne z najlepszych wyników na rynku
          </p>
        </div>
        <Statistics />
      </section>

      {/* Process Timeline */}
      <section id="proces" className="bg-gradient-to-br from-slate-50 to-blue-50 py-16 md:py-24">
        <div className="max-w-7xl mx-auto px-6">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold text-slate-900 mb-4">
              Jak wygląda proces?
            </h2>
            <p className="text-lg text-slate-600 max-w-2xl mx-auto">
              Prowadzimy Cię krok po kroku przez cały proces. Nie musisz się o nic martwić.
            </p>
          </div>
          <ProcessTimeline />
        </div>
      </section>

      {/* Requirements */}
      <section className="max-w-7xl mx-auto px-6 py-16 md:py-24">
        <Requirements />
      </section>

      {/* Risks */}
      <section className="max-w-7xl mx-auto px-6 py-16 md:py-24">
        <Risks />
      </section>

      {/* FAQ Quick */}
      <section className="bg-gradient-to-br from-slate-900 to-blue-900 text-white py-16 md:py-24">
        <div className="max-w-7xl mx-auto px-6">
          <h2 className="text-3xl md:text-4xl font-bold mb-12 text-center">
            Najczęściej zadawane pytania
          </h2>

          <div className="grid md:grid-cols-2 gap-8 max-w-5xl mx-auto">
            <div className="bg-white/10 backdrop-blur-sm rounded-xl p-6 border border-white/20">
              <h3 className="text-xl font-bold mb-3">Czy muszę płacić z góry?</h3>
              <p className="text-blue-100">
                Nie. Pracujemy na zasadzie success fee - płacisz tylko wtedy, gdy wygramy sprawę.
                Konsultacja jest całkowicie bezpłatna.
              </p>
            </div>

            <div className="bg-white/10 backdrop-blur-sm rounded-xl p-6 border border-white/20">
              <h3 className="text-xl font-bold mb-3">Ile mogę odzyskać?</h3>
              <p className="text-blue-100">
                Średnio nasi klienci odzyskują 250 000 PLN. Kwota zależy od wysokości kredytu,
                czasu spłaty i nadpłaconych rat. Sprawdzimy to podczas bezpłatnej konsultacji.
              </p>
            </div>

            <div className="bg-white/10 backdrop-blur-sm rounded-xl p-6 border border-white/20">
              <h3 className="text-xl font-bold mb-3">Ile trwa postępowanie?</h3>
              <p className="text-blue-100">
                Średnio 18 miesięcy od złożenia pozwu do prawomocnego wyroku. Czas może się
                wydłużyć, jeśli bank złoży apelację.
              </p>
            </div>

            <div className="bg-white/10 backdrop-blur-sm rounded-xl p-6 border border-white/20">
              <h3 className="text-xl font-bold mb-3">Co jeśli przegram?</h3>
              <p className="text-blue-100">
                Przed podjęciem sprawy oceniamy Twoje szanse. Jeśli przegrasz, nie płacisz nam
                wynagrodzenia. Większość spraw frankowych kończy się jednak sukcesem klienta.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Contact Form */}
      <section id="kontakt" className="max-w-3xl mx-auto px-6 py-16 md:py-24">
        <LeadForm />
      </section>

      {/* Footer */}
      <footer className="bg-slate-900 text-slate-400 py-12">
        <div className="max-w-7xl mx-auto px-6">
          <div className="grid md:grid-cols-3 gap-8 mb-8">
            <div>
              <h3 className="text-white font-bold text-lg mb-4">Kredyty Frankowe</h3>
              <p className="text-sm leading-relaxed">
                Profesjonalna pomoc prawna w unieważnianiu kredytów frankowych.
                Działamy na terenie całej Polski.
              </p>
            </div>

            <div>
              <h3 className="text-white font-bold text-lg mb-4">Kontakt</h3>
              <p className="text-sm mb-2">Email: kontakt@frankowe.pl</p>
              <p className="text-sm mb-2">Tel: +48 123 456 789</p>
              <p className="text-sm">Poniedziałek - Piątek: 9:00 - 18:00</p>
            </div>

            <div>
              <h3 className="text-white font-bold text-lg mb-4">Informacje</h3>
              <ul className="text-sm space-y-2">
                <li><a href="#" className="hover:text-white transition-colors">Polityka prywatności</a></li>
                <li><a href="#" className="hover:text-white transition-colors">Regulamin</a></li>
                <li><a href="#" className="hover:text-white transition-colors">RODO</a></li>
              </ul>
            </div>
          </div>

          <div className="border-t border-slate-800 pt-8 text-center text-sm">
            <p>&copy; 2026 Kredyty Frankowe. Wszystkie prawa zastrzeżone.</p>
            <p className="mt-2 text-xs">
              Informacje na stronie mają charakter informacyjny i nie stanowią porady prawnej.
              Każda sprawa wymaga indywidualnej analizy.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
