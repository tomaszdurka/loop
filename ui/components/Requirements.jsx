export default function Requirements() {
  const requirements = [
    {
      icon: "📄",
      title: "Umowa kredytowa",
      description: "Oryginalna umowa kredytu frankowego lub jej kopia"
    },
    {
      icon: "📊",
      title: "Historia spłat",
      description: "Wyciągi bankowe lub historia wpłat na kredyt"
    },
    {
      icon: "🏦",
      title: "Dokumenty bankowe",
      description: "Regulamin, tabele kursowe, aneksy do umowy"
    },
    {
      icon: "✍️",
      title: "Dane osobowe",
      description: "Dowód osobisty lub paszport do celów reprezentacji"
    },
    {
      icon: "🏠",
      title: "Dokumenty nieruchomości",
      description: "Akt notarialny, wypis z księgi wieczystej (jeśli dotyczy)"
    },
    {
      icon: "⚖️",
      title: "Pełnomocnictwo",
      description: "Udzielone naszej kancelarii do reprezentacji w sądzie"
    }
  ];

  return (
    <div className="rounded-3xl bg-gradient-to-br from-slate-50 to-blue-50 p-8 md:p-12">
      <div className="text-center mb-12">
        <h2 className="text-3xl md:text-4xl font-bold text-slate-900 mb-4">
          Czego potrzebujesz?
        </h2>
        <p className="text-lg text-slate-600 max-w-2xl mx-auto">
          Przygotuj poniższe dokumenty, aby przyspieszyć proces analizy Twojej sprawy
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {requirements.map((req, index) => (
          <div
            key={index}
            className="bg-white rounded-xl p-6 shadow-sm hover:shadow-md transition-shadow border border-slate-100"
          >
            <div className="text-4xl mb-4">{req.icon}</div>
            <h3 className="text-lg font-bold text-slate-900 mb-2">{req.title}</h3>
            <p className="text-slate-600 text-sm leading-relaxed">{req.description}</p>
          </div>
        ))}
      </div>

      <div className="mt-8 p-6 bg-blue-100 border-l-4 border-blue-600 rounded-lg">
        <p className="text-sm text-blue-900">
          <strong>Nie masz wszystkich dokumentów?</strong> Nie martw się! Pomożemy Ci je zdobyć.
          Część dokumentów możemy uzyskać bezpośrednio z banku w ramach współpracy.
        </p>
      </div>
    </div>
  );
}
